import {
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  StackProps,
} from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { CfnGuardrail, CfnGuardrailVersion } from 'aws-cdk-lib/aws-bedrock';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as glue from 'aws-cdk-lib/aws-glue';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecr_assets from 'aws-cdk-lib/aws-ecr-assets';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as url from 'url';
import {
  PortalWebsite,
  UserIdentity,
  RuntimeConfig,
} from ':billing-partner-portal/common-constructs';

export class ApplicationStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const identity = new UserIdentity(this, 'Identity');

    // ── Configuration from environment (set by `pnpm setup`) ───────────────
    const curBucketName =
      process.env.CUR_BUCKET_NAME ||
      `billing-portal-cur-data-${this.account}-${this.region}`;
    const athenaResultsBucketName =
      process.env.ATHENA_RESULTS_BUCKET ||
      `billing-portal-athena-results-${this.account}-${this.region}`;
    const glueDatabaseName =
      process.env.ATHENA_DATABASE || 'billing_portal_cur';
    const crawlerName =
      process.env.GLUE_CRAWLER_NAME || 'billing-portal-cur-crawler';
    const bedrockModelId =
      process.env.BEDROCK_MODEL_ID ||
      'us.anthropic.claude-sonnet-4-20250514-v1:0';
    const legacyCurPath =
      this.node.tryGetContext('legacyCurS3Path') ||
      process.env.LEGACY_CUR_S3_PATH ||
      '';

    // ── Athena / Glue / S3 for Customer Reports ────────────────────────────

    const athenaResultsBucket = new s3.Bucket(this, 'AthenaResultsBucket', {
      bucketName: athenaResultsBucketName,
      removalPolicy: RemovalPolicy.RETAIN,
      enforceSSL: true,
      versioned: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      lifecycleRules: [{ expiration: Duration.days(30) }],
      serverAccessLogsPrefix: 'access-logs/',
    });

    const curBucket = new s3.Bucket(this, 'CurDataBucket', {
      bucketName: curBucketName,
      removalPolicy: RemovalPolicy.RETAIN,
      enforceSSL: true,
      versioned: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      serverAccessLogsPrefix: 'access-logs/',
    });

    // Allow BCM Data Exports to write CUR data to this bucket
    curBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowBCMDataExportsWrite',
        effect: iam.Effect.ALLOW,
        principals: [
          new iam.ServicePrincipal('bcm-data-exports.amazonaws.com'),
          new iam.ServicePrincipal('billingreports.amazonaws.com'),
        ],
        actions: ['s3:GetBucketPolicy', 's3:GetBucketAcl', 's3:PutObject'],
        resources: [curBucket.bucketArn, `${curBucket.bucketArn}/*`],
      }),
    );

    const glueDatabase = new glue.CfnDatabase(this, 'CurDatabase', {
      catalogId: this.account,
      databaseInput: {
        name: glueDatabaseName,
        description: 'Glue database for CUR 2.0 Parquet data',
      },
    });

    const crawlerRole = new iam.Role(this, 'CurCrawlerRole', {
      assumedBy: new iam.ServicePrincipal('glue.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          'service-role/AWSGlueServiceRole',
        ),
      ],
    });
    curBucket.grantRead(crawlerRole);

    const glueKey = new kms.Key(this, 'GlueEncryptionKey', {
      enableKeyRotation: true,
      description: 'KMS key for Glue crawler encryption',
    });
    glueKey.addToResourcePolicy(
      new iam.PolicyStatement({
        actions: [
          'kms:Encrypt',
          'kms:Decrypt',
          'kms:ReEncrypt*',
          'kms:GenerateDataKey*',
          'kms:DescribeKey',
        ],
        principals: [
          new iam.ServicePrincipal(`logs.${this.region}.amazonaws.com`),
        ],
        resources: ['*'],
      }),
    );
    glueKey.grantEncryptDecrypt(crawlerRole);
    crawlerRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: [
          'logs:AssociateKmsKey',
          'logs:CreateLogGroup',
          'logs:CreateLogStream',
          'logs:PutLogEvents',
        ],
        resources: ['*'],
      }),
    );

    const glueSecurityConfig = new glue.CfnSecurityConfiguration(
      this,
      'CurCrawlerSecurityConfig',
      {
        name: `${crawlerName}-security-config`,
        encryptionConfiguration: {
          s3Encryptions: [{ s3EncryptionMode: 'SSE-S3' }],
          cloudWatchEncryption: {
            cloudWatchEncryptionMode: 'SSE-KMS',
            kmsKeyArn: glueKey.keyArn,
          },
          jobBookmarksEncryption: {
            jobBookmarksEncryptionMode: 'CSE-KMS',
            kmsKeyArn: glueKey.keyArn,
          },
        },
      },
    );

    const s3Targets: glue.CfnCrawler.S3TargetProperty[] = [
      { path: `s3://${curBucket.bucketName}/` },
    ];
    if (legacyCurPath) {
      s3Targets.push({ path: legacyCurPath });
      // Grant crawler read access to the legacy bucket
      crawlerRole.addToPrincipalPolicy(
        new iam.PolicyStatement({
          actions: ['s3:GetObject', 's3:ListBucket'],
          resources: [
            `arn:aws:s3:::${legacyCurPath.replace('s3://', '').split('/')[0]}`,
            `arn:aws:s3:::${legacyCurPath.replace('s3://', '').split('/')[0]}/*`,
          ],
        }),
      );
    }

    const crawler = new glue.CfnCrawler(this, 'CurCrawler', {
      name: crawlerName,
      role: crawlerRole.roleArn,
      databaseName: glueDatabaseName,
      crawlerSecurityConfiguration: glueSecurityConfig.ref,
      targets: { s3Targets },
      schemaChangePolicy: {
        updateBehavior: 'UPDATE_IN_DATABASE',
        deleteBehavior: 'LOG',
      },
    });
    crawler.addDependency(glueDatabase);

    new CfnOutput(this, 'AthenaResultsBucketName', {
      value: athenaResultsBucket.bucketName,
    });
    new CfnOutput(this, 'CurDataBucketName', { value: curBucket.bucketName });
    new CfnOutput(this, 'GlueDatabaseName', { value: glueDatabaseName });
    new CfnOutput(this, 'GlueCrawlerName', { value: crawlerName });

    // ── Bedrock Guardrail ──────────────────────────────────────────────────

    const guardrail = new CfnGuardrail(this, 'BillingAssistantGuardrail', {
      name: 'BillingPortalGuardrail',
      description:
        'Content guardrail for the Billing Transfer Automation Portal AI assistant',
      blockedInputMessaging:
        'Sorry, I can only help with billing and cost management questions.',
      blockedOutputsMessaging:
        'Sorry, I cannot provide that information. Please ask about billing, costs, or transfers.',
      contentPolicyConfig: {
        filtersConfig: [
          { type: 'SEXUAL', inputStrength: 'HIGH', outputStrength: 'HIGH' },
          { type: 'VIOLENCE', inputStrength: 'HIGH', outputStrength: 'HIGH' },
          { type: 'HATE', inputStrength: 'HIGH', outputStrength: 'HIGH' },
          { type: 'INSULTS', inputStrength: 'HIGH', outputStrength: 'HIGH' },
          { type: 'MISCONDUCT', inputStrength: 'HIGH', outputStrength: 'HIGH' },
          {
            type: 'PROMPT_ATTACK',
            inputStrength: 'HIGH',
            outputStrength: 'NONE',
          },
        ],
      },
      topicPolicyConfig: {
        topicsConfig: [
          {
            name: 'OffTopic',
            definition:
              'Questions unrelated to AWS billing, cost management, billing transfers, pricing, or financial operations.',
            type: 'DENY',
            examples: [
              'Write me a poem',
              'What is the weather today',
              'Help me write code',
              'Tell me a joke',
            ],
          },
        ],
      },
      sensitiveInformationPolicyConfig: {
        piiEntitiesConfig: [
          { type: 'EMAIL', action: 'ANONYMIZE' },
          { type: 'PHONE', action: 'ANONYMIZE' },
          { type: 'US_SOCIAL_SECURITY_NUMBER', action: 'BLOCK' },
          { type: 'CREDIT_DEBIT_CARD_NUMBER', action: 'BLOCK' },
        ],
      },
    });

    const guardrailVersion = new CfnGuardrailVersion(
      this,
      'BillingAssistantGuardrailVersion',
      { guardrailIdentifier: guardrail.attrGuardrailId },
    );
    void guardrailVersion;

    // ── Fargate Backend ────────────────────────────────────────────────────

    const vpc = new ec2.Vpc(this, 'BillingPortalVpc', {
      maxAzs: 2,
      natGateways: 1,
    });

    // ── Account Registry (DynamoDB) ────────────────────────────────────────

    const accountsTable = new dynamodb.Table(this, 'AccountRegistry', {
      tableName: 'billing-portal-accounts',
      partitionKey: { name: 'account_id', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      pointInTimeRecovery: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // ── ECS Fargate ────────────────────────────────────────────────────────

    const cluster = new ecs.Cluster(this, 'BillingApiCluster', {
      vpc,
      containerInsightsV2: ecs.ContainerInsights.ENABLED,
    });

    const image = new ecr_assets.DockerImageAsset(this, 'BillingApiImage', {
      directory: url.fileURLToPath(new URL('../../../..', import.meta.url)),
      file: 'Dockerfile',
      platform: ecr_assets.Platform.LINUX_AMD64,
    });

    const taskDef = new ecs.FargateTaskDefinition(this, 'BillingApiTask', {
      cpu: 512,
      memoryLimitMiB: 1024,
      taskRole: new iam.Role(this, 'BillingPortalTaskRole', {
        roleName: 'BillingPortalTaskRole',
        assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      }),
    });

    // Grant the task role scoped billing + Bedrock permissions
    taskDef.taskRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('ReadOnlyAccess'),
    );
    // Billing APIs — do not support resource-level permissions, require *
    taskDef.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: 'BillingAPIs',
        actions: [
          'billingconductor:List*',
          'billingconductor:Get*',
          'billingconductor:CreateCustomLineItem',
          'billingconductor:UpdateCustomLineItem',
          'bcm-data-exports:CreateExport',
          'bcm-data-exports:DeleteExport',
          'bcm-data-exports:GetExport',
          'bcm-data-exports:ListExports',
          'bcm-data-exports:UpdateExport',
          'billing:ListBillingViews',
          'ce:Get*',
          'ce:Describe*',
          'ce:List*',
          'cur:DescribeReportDefinitions',
          'cur:PutReportDefinition',
          'budgets:ViewBudget',
        ],
        resources: ['*'],
      }),
    );
    // Athena/Glue — scoped to the billing portal database
    taskDef.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: 'AthenaGlue',
        actions: [
          'athena:StartQueryExecution',
          'athena:GetQueryExecution',
          'athena:GetQueryResults',
          'glue:GetDatabase',
          'glue:GetTable',
          'glue:GetTables',
          'glue:StartCrawler',
          'glue:GetCrawler',
        ],
        resources: [
          `arn:aws:athena:${this.region}:${this.account}:workgroup/*`,
          `arn:aws:glue:${this.region}:${this.account}:catalog`,
          `arn:aws:glue:${this.region}:${this.account}:database/${glueDatabaseName}`,
          `arn:aws:glue:${this.region}:${this.account}:table/${glueDatabaseName}/*`,
          `arn:aws:glue:${this.region}:${this.account}:crawler/${crawlerName}`,
        ],
      }),
    );
    // S3 — scoped to the CUR and Athena buckets
    taskDef.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: 'S3Access',
        actions: ['s3:GetObject', 's3:PutObject', 's3:ListBucket'],
        resources: [
          curBucket.bucketArn,
          `${curBucket.bucketArn}/*`,
          athenaResultsBucket.bucketArn,
          `${athenaResultsBucket.bucketArn}/*`,
        ],
      }),
    );
    // Bedrock — scoped to the region
    taskDef.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: 'Bedrock',
        actions: [
          'bedrock:InvokeModel',
          'bedrock:InvokeModelWithResponseStream',
          'bedrock:ApplyGuardrail',
        ],
        resources: [
          `arn:aws:bedrock:*::foundation-model/*`,
          `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/*`,
          `arn:aws:bedrock:${this.region}:${this.account}:guardrail/*`,
        ],
      }),
    );

    // DynamoDB access for account registry
    accountsTable.grantReadWriteData(taskDef.taskRole);

    // Cross-account assume role for multi-account billing operations
    taskDef.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: 'AssumeTargetAccountRoles',
        actions: ['sts:AssumeRole'],
        resources: ['arn:aws:iam::*:role/BillingPortalCrossAccountRole'],
      }),
    );

    taskDef.addContainer('api', {
      image: ecs.ContainerImage.fromDockerImageAsset(image),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'billing-api',
        logGroup: new logs.LogGroup(this, 'BillingApiContainerLogs', {
          retention: logs.RetentionDays.TWO_WEEKS,
          encryptionKey: glueKey,
        }),
      }),
      environment: {
        AWS_REGION: this.region,
        AWS_ACCOUNT_ID: this.account,
        ATHENA_DATABASE: glueDatabaseName,
        ATHENA_TABLE: 'cur_data',
        ATHENA_RESULTS_BUCKET: athenaResultsBucket.bucketName,
        BEDROCK_GUARDRAIL_ID: guardrail.attrGuardrailId,
        BEDROCK_GUARDRAIL_VERSION: 'DRAFT',
        BEDROCK_MODEL_ID: bedrockModelId,
        GLUE_CRAWLER_NAME: crawlerName,
        CUR_BUCKET_NAME: curBucket.bucketName,
        ACCOUNTS_TABLE_NAME: accountsTable.tableName,
      },
      portMappings: [{ containerPort: 8000 }],
      healthCheck: {
        command: [
          'CMD-SHELL',
          'python -c "import urllib.request; urllib.request.urlopen(\'http://localhost:8000/echo?message=health\')" || exit 1',
        ],
        interval: Duration.seconds(30),
        timeout: Duration.seconds(5),
        retries: 3,
      },
    });

    const service = new ecs.FargateService(this, 'BillingApiService', {
      cluster,
      taskDefinition: taskDef,
      desiredCount: 1,
      assignPublicIp: false,
    });

    const albLogsBucket = new s3.Bucket(this, 'AlbLogsBucket', {
      enforceSSL: true,
      versioned: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      lifecycleRules: [{ expiration: Duration.days(90) }],
      serverAccessLogsPrefix: 'access-logs/',
    });

    const alb = new elbv2.ApplicationLoadBalancer(this, 'BillingApiAlb', {
      vpc,
      internetFacing: true,
      dropInvalidHeaderFields: true,
    });
    alb.logAccessLogs(albLogsBucket, 'alb-logs');

    const listener = alb.addListener('HttpListener', { port: 80 });
    listener.addTargets('BillingApiTarget', {
      port: 8000,
      targets: [service],
      healthCheck: {
        path: '/echo?message=health',
        interval: Duration.seconds(30),
      },
    });

    // ── API Gateway (Cognito auth) → ALB ───────────────────────────────────

    const apiLogGroup = new logs.LogGroup(this, 'BillingApiAccessLogs', {
      retention: logs.RetentionDays.TWO_WEEKS,
      encryptionKey: glueKey,
    });

    // Account-level setting: API Gateway needs a role to write CloudWatch Logs
    const apigwLogsRole = new iam.Role(this, 'ApiGatewayCloudWatchRole', {
      assumedBy: new iam.ServicePrincipal('apigateway.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          'service-role/AmazonAPIGatewayPushToCloudWatchLogs',
        ),
      ],
    });
    new apigateway.CfnAccount(this, 'ApiGatewayAccount', {
      cloudWatchRoleArn: apigwLogsRole.roleArn,
    });

    const api = new apigateway.RestApi(this, 'BillingApi', {
      restApiName: 'BillingApi',
      deployOptions: {
        accessLogDestination: new apigateway.LogGroupLogDestination(
          apiLogGroup,
        ),
        accessLogFormat: apigateway.AccessLogFormat.jsonWithStandardFields(),
        loggingLevel: apigateway.MethodLoggingLevel.INFO,
        tracingEnabled: true,
        cachingEnabled: false,
        throttlingBurstLimit: 50,
        throttlingRateLimit: 100,
      },
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: ['Content-Type', 'Authorization', 'X-Account-Id'],
      },
    });

    const authorizer = new apigateway.CognitoUserPoolsAuthorizer(
      this,
      'BillingApiAuthorizer',
      { cognitoUserPools: [identity.userPool] },
    );

    const albIntegration = new apigateway.HttpIntegration(
      `http://${alb.loadBalancerDnsName}/{proxy}`,
      {
        httpMethod: 'ANY',
        options: {
          requestParameters: {
            'integration.request.path.proxy': 'method.request.path.proxy',
          },
        },
      },
    );

    api.root.addProxy({
      defaultIntegration: albIntegration,
      defaultMethodOptions: {
        authorizer,
        authorizationType: apigateway.AuthorizationType.COGNITO,
        requestParameters: { 'method.request.path.proxy': true },
      },
    });

    new CfnOutput(this, 'BillingApiEndpoint', {
      value: api.url,
    });

    // Register API URL in runtime config so the frontend can discover it
    const rc = RuntimeConfig.ensure(this);
    rc.set('connection', 'apis', { BillingApi: api.url });

    // ── Frontend ───────────────────────────────────────────────────────────

    new PortalWebsite(this, 'PortalWebsite');

    // CORS is configured as ALL_ORIGINS in the API Gateway preflight because
    // the CloudFront domain is not known until after deployment. The actual
    // security is enforced by the Cognito authorizer on all non-OPTIONS methods.
  }
}
