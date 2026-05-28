# IAM Roles & Policies

All IAM roles are created by AWS CDK during deployment. No manual IAM configuration is required.

## Fargate Task Execution Role

**Purpose:** Allows ECS to pull the Docker image from ECR and write container logs.

| Permission | Resource | Purpose |
|-----------|----------|---------|
| `ecr:GetAuthorizationToken` | `*` | Authenticate to ECR |
| `ecr:BatchGetImage`, `ecr:GetDownloadUrlForLayer` | ECR repository ARN | Pull container image |
| `logs:CreateLogStream`, `logs:PutLogEvents` | Log group ARN | Write container logs |

## Fargate Task Role

**Purpose:** Runtime permissions for the billing API container.

| Policy | Actions | Resource Scope | Purpose |
|--------|---------|---------------|---------|
| **ReadOnlyAccess** (managed) | Read-only across AWS | `*` | MCP server needs broad read access for cost explorer, billing conductor queries |
| **BillingAPIs** | `billingconductor:List*,Get*,CreateCustomLineItem,UpdateCustomLineItem`, `bcm-data-exports:*Export*`, `billing:ListBillingViews`, `ce:Get*,Describe*,List*`, `cur:DescribeReportDefinitions,PutReportDefinition`, `budgets:ViewBudget` | `*` (billing APIs do not support resource-level permissions) | Read billing data, create CUR exports, manage custom line items |
| **AthenaGlue** | `athena:StartQueryExecution,GetQueryExecution,GetQueryResults`, `glue:GetDatabase,GetTable,GetTables,StartCrawler,GetCrawler` | Scoped to account/region: specific database, tables, crawler, workgroup | Query CUR data for customer reports, run crawler |
| **S3Access** | `s3:GetObject,PutObject,ListBucket` | CUR data bucket ARN, Athena results bucket ARN | Read CUR Parquet files, write Athena query results |
| **Bedrock** | `bedrock:InvokeModel,InvokeModelWithResponseStream,ApplyGuardrail` | Foundation models in region, guardrails in account | AI billing assistant chat |

## Glue Crawler Role

**Purpose:** Crawls S3 CUR data and catalogs it in the Glue Data Catalog.

| Policy | Actions | Resource Scope | Purpose |
|--------|---------|---------------|---------|
| **AWSGlueServiceRole** (managed) | Glue service permissions | `*` | Standard Glue crawler operations |
| **CurBucketRead** | `s3:GetObject,ListBucket` | CUR data bucket ARN (+ legacy bucket if configured) | Read CUR Parquet files |
| **KMS** | `kms:Encrypt,Decrypt,GenerateDataKey*` | Glue encryption key ARN | Encrypt CloudWatch logs and job bookmarks |
| **CloudWatch** | `logs:AssociateKmsKey,CreateLogGroup,CreateLogStream,PutLogEvents` | `*` | Write encrypted crawler logs |

## Cognito Identity Pool Roles

**Purpose:** Federated identity for authenticated and unauthenticated users.

| Role | Purpose |
|------|---------|
| **Authenticated Role** | Grants authenticated users access to invoke the API Gateway |
| **Unauthenticated Role** | Minimal permissions (no API access) |

## S3 Bucket Policies

| Bucket | Service Principal | Actions | Purpose |
|--------|------------------|---------|---------|
| CUR Data Bucket | `bcm-data-exports.amazonaws.com`, `billingreports.amazonaws.com` | `s3:GetBucketPolicy,PutObject` | AWS delivers CUR data to this bucket |

## KMS Key Policy

| Principal | Actions | Purpose |
|-----------|---------|---------|
| CloudWatch Logs service | `kms:Encrypt,Decrypt,ReEncrypt*,GenerateDataKey*,DescribeKey` | Encrypt Glue crawler logs and API Gateway access logs |
| Glue crawler role | `kms:Encrypt,Decrypt` | Encrypt job bookmarks and CloudWatch logs |

## Cross-Account Role (Bill-Receiver Accounts)

**Purpose:** Deployed via CloudFormation (`docs/cross-account-role.yaml`) in each bill-receiver account. Allows the portal's Fargate Task Role to assume into the target account and perform billing operations.

**Trust Policy:**
- Principal: `arn:aws:iam::<PortalAccountId>:role/BillingPortalTaskRole`
- Condition: `sts:ExternalId` must match the configured external ID (confused deputy protection)

| Policy | Actions | Resource Scope | Purpose |
|--------|---------|---------------|---------|
| **BillingConductorAccess** | `billingconductor:List*,Get*,CreateCustomLineItem,UpdateCustomLineItem,DeleteCustomLineItem,BatchAssociate*,BatchDisassociate*` | `*` | Manage billing groups, pricing, CLIs |
| **CostManagementAccess** | `ce:Get*,List*,Describe*`, `billing:ListBillingViews,GetBillingView`, `budgets:Describe*,View*` | `*` | Cost Explorer, Billing Views, Budgets |
| **CurExportAccess** | `bcm-data-exports:Create/Get/List/Update/DeleteExport`, `cur:PutReportDefinition,DeleteReportDefinition,DescribeReportDefinitions` | `*` | CUR 2.0 export provisioning |
| **AthenaGlueAccess** | `athena:StartQueryExecution,GetQueryExecution,GetQueryResults`, `glue:GetDatabase,GetTable,GetTables,GetCrawler,StartCrawler,UpdateCrawler` | Scoped to `billing_portal_cur` database, workgroup `primary` | Customer report queries, catalog management |
| **S3CurDataAccess** | `s3:GetObject,PutObject,ListBucket,GetBucketLocation` | CUR data bucket, Athena results bucket | Read CUR Parquet, write query results |

**Deployment:**
```bash
aws cloudformation deploy \
  --template-file docs/cross-account-role.yaml \
  --stack-name billing-portal-cross-account \
  --parameter-overrides PortalAccountId=<portal-account-id> \
  --capabilities CAPABILITY_NAMED_IAM
```

## Security Notes

- **Billing APIs require `*` resources** — AWS Billing Conductor, Cost Explorer, and BCM Data Exports do not support resource-level IAM permissions.
- **ReadOnlyAccess managed policy** — Required by the MCP server which calls multiple AWS APIs dynamically. All write operations are explicitly scoped.
- **No Lambda functions** — The backend runs on ECS Fargate (not Lambda), so Lambda VPC findings do not apply.
- **CORS wildcard on API Gateway** — Only applies to OPTIONS preflight requests. All data requests require a valid Cognito JWT token.
- **Chat input validation** — Message length capped at configurable max, session IDs validated with regex pattern `^[a-zA-Z0-9_-]+$`.
