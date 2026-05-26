import { Construct } from 'constructs';
import * as url from 'url';
import { Distribution } from 'aws-cdk-lib/aws-cloudfront';
import {
  Code,
  Runtime,
  Function,
  FunctionProps,
  Tracing,
  LayerVersion,
} from 'aws-cdk-lib/aws-lambda';
import { RuntimeConfig } from '../../core/runtime-config.js';
import {
  AuthorizationType,
  LambdaIntegration,
  ResponseTransferMode,
  CognitoUserPoolsAuthorizer,
} from 'aws-cdk-lib/aws-apigateway';
import { Aspects, Duration, Stack } from 'aws-cdk-lib';
import {
  PolicyDocument,
  PolicyStatement,
  Effect,
  AnyPrincipal,
} from 'aws-cdk-lib/aws-iam';
import { IUserPool } from 'aws-cdk-lib/aws-cognito';
import { Queue, QueueEncryption } from 'aws-cdk-lib/aws-sqs';
import { Key } from 'aws-cdk-lib/aws-kms';
import {
  ApiIntegrations,
  IntegrationBuilder,
  RestApiIntegration,
} from '../../core/api/utils.js';
import { AddCorsPreflightAspect, RestApi } from '../../core/api/rest-api.js';
import { suppressRules } from '../../core/checkov.js';
import {
  OPERATION_DETAILS,
  Operations,
} from '../../generated/billing-api/metadata.gen.js';

/**
 * Properties for creating a BillingApi construct
 *
 * @template TIntegrations - Map of operation names to their integrations
 */
export interface BillingApiProps<
  TIntegrations extends ApiIntegrations<Operations, RestApiIntegration>,
> {
  /**
   * Map of operation names to their API Gateway integrations
   */
  integrations: TIntegrations;
  /**
   * Identity details for Cognito Authentication
   */
  identity: {
    userPool: IUserPool;
  };
}

/**
 * A CDK construct that creates and configures an AWS API Gateway REST API
 * specifically for BillingApi.
 * @template TIntegrations - Map of operation names to their integrations
 */
export class BillingApi<
  TIntegrations extends ApiIntegrations<Operations, RestApiIntegration>,
> extends RestApi<Operations, TIntegrations> {
  private allowedOrigins: readonly string[] = ['*'];

  /**
   * Creates default integrations for all operations, which implement each operation as
   * its own individual lambda function.
   *
   * @param scope - The CDK construct scope
   * @returns An IntegrationBuilder with default lambda integrations
   */
  public static defaultIntegrations = (scope: Construct) => {
    const rc = RuntimeConfig.ensure(scope);
    return IntegrationBuilder.rest({
      pattern: 'isolated',
      operations: OPERATION_DETAILS,
      defaultIntegrationOptions: <FunctionProps>{
        runtime: Runtime.PYTHON_3_12,
        handler: 'run.sh',
        code: Code.fromAsset(
          url.fileURLToPath(
            new URL(
              '../../../../../../dist/packages/billing_api/bundle-x86',
              import.meta.url,
            ),
          ),
        ),
        timeout: Duration.seconds(120),
        memorySize: 512,
        tracing: Tracing.ACTIVE,
        environment: {
          AWS_CONNECTION_REUSE_ENABLED: '1',
          RUNTIME_CONFIG_APP_ID: rc.appConfigApplicationId,
          PORT: '8000',
          AWS_LWA_INVOKE_MODE: 'response_stream',
          AWS_LAMBDA_EXEC_WRAPPER: '/opt/bootstrap',
        },
      },
      buildDefaultIntegration: (op, props: FunctionProps) => {
        const dlq = new Queue(scope, `BillingApi${op}DLQ`, {
          retentionPeriod: Duration.days(14),
          encryption: QueueEncryption.KMS_MANAGED,
        });
        const envKey = new Key(scope, `BillingApi${op}EnvKey`, {
          enableKeyRotation: true,
          description: `KMS key for ${op} Lambda env vars`,
        });
        const handler = new Function(scope, `BillingApi${op}Handler`, {
          ...props,
          reservedConcurrentExecutions: 10,
          deadLetterQueue: dlq,
          environmentEncryption: envKey,
        });
        suppressRules(
          handler,
          ['CKV_AWS_117'],
          'API Lambdas call AWS APIs directly; VPC adds latency and NAT cost with no security benefit',
        );
        rc.grantReadAppConfig(handler);
        const stack = Stack.of(scope);
        handler.addLayers(
          LayerVersion.fromLayerVersionArn(
            scope,
            `BillingApi${op}LWALayer`,
            `arn:aws:lambda:${stack.region}:753240598075:layer:LambdaAdapterLayerX86:24`,
          ),
        );
        return {
          handler,
          integration: new LambdaIntegration(handler.currentVersion, {
            responseTransferMode: ResponseTransferMode.STREAM,
            timeout: Duration.seconds(60),
          }),
        };
      },
    });
  };

  constructor(
    scope: Construct,
    id: string,
    props: BillingApiProps<TIntegrations>,
  ) {
    super(scope, id, {
      apiName: 'BillingApi',
      defaultMethodOptions: {
        authorizationType: AuthorizationType.COGNITO,
        authorizer: new CognitoUserPoolsAuthorizer(
          scope,
          'BillingApiAuthorizer',
          {
            cognitoUserPools: [props.identity.userPool],
          },
        ),
      },
      deployOptions: {
        tracingEnabled: true,
      },
      policy: new PolicyDocument({
        statements: [
          // Allow all callers to invoke the API in the resource policy, since auth is handled by Cognito
          new PolicyStatement({
            effect: Effect.ALLOW,
            principals: [new AnyPrincipal()],
            actions: ['execute-api:Invoke'],
            resources: ['execute-api:/*'],
          }),
        ],
      }),
      operations: OPERATION_DETAILS,
      ...props,
    });
    Aspects.of(this).add(new AddCorsPreflightAspect(() => this.allowedOrigins));
  }

  /**
   * Restricts CORS to the provided origins
   *
   * Configures the provided CloudFront distribution domains or origin strings
   * as the only permitted CORS origins in API Gateway preflight responses and the
   * AWS Lambda integrations.
   *
   * @param origins - The origin strings, CloudFront distributions, or objects containing a CloudFront distribution to grant CORS from
   */
  public restrictCorsTo(
    ...origins: (
      | string
      | Distribution
      | { cloudFrontDistribution: Distribution }
    )[]
  ) {
    const allowedOrigins = origins.map((origin) =>
      typeof origin === 'string'
        ? origin
        : 'cloudFrontDistribution' in origin
          ? `https://${origin.cloudFrontDistribution.distributionDomainName}`
          : `https://${origin.distributionDomainName}`,
    );

    this.allowedOrigins = allowedOrigins;

    // Set ALLOWED_ORIGINS environment variable for all Lambda integrations
    Object.values(this.integrations).forEach((integration) => {
      if ('handler' in integration && integration.handler instanceof Function) {
        integration.handler.addEnvironment(
          'ALLOWED_ORIGINS',
          allowedOrigins.join(','),
        );
      }
    });
  }
}
