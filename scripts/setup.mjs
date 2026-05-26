#!/usr/bin/env node
// Interactive .env setup — prompts for required values, auto-detects where possible.
// Works on macOS, Linux, and Windows (PowerShell / cmd).
// No external dependencies — Node.js built-ins only.
import { createInterface } from 'readline';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = resolve(__dirname, '../.env');
const EXAMPLE_PATH = resolve(__dirname, '../.env.example');

const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = (question, defaultValue) =>
  new Promise((res) => {
    const hint = defaultValue ? ` [${defaultValue}]` : '';
    rl.question(`${question}${hint}: `, (answer) => res(answer.trim() || defaultValue || ''));
  });

function run(cmd) {
  try {
    return execSync(cmd, { stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim();
  } catch {
    return '';
  }
}

function detectAccountId(profile) {
  const profileArg = profile ? `--profile ${profile}` : '';
  const result = run(`aws sts get-caller-identity ${profileArg} --query Account --output text`);
  return result && !result.includes('error') ? result : '';
}

function listProfiles() {
  const result = run('aws configure list-profiles');
  return result ? result.split('\n').filter(Boolean) : [];
}

function detectRegion(profile) {
  const profileArg = profile ? `--profile ${profile}` : '';
  return run(`aws configure get region ${profileArg}`) || 'us-east-1';
}

async function main() {
  console.log('\n🔧 Billing Transfer Automation Portal — Setup\n');
  console.log('This will create a .env file for local development.');
  console.log('The deployed application gets its config from CDK.\n');

  // Load existing .env if present
  const existing = {};
  if (existsSync(ENV_PATH)) {
    for (const line of readFileSync(ENV_PATH, 'utf8').split('\n')) {
      const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)/);
      if (match) existing[match[1]] = match[2];
    }
    console.log('Found existing .env — current values shown as defaults.\n');
  }

  // Show available profiles
  const profiles = listProfiles();
  if (profiles.length > 0) {
    console.log(`Available AWS profiles: ${profiles.join(', ')}\n`);
  }

  // AWS Profile
  console.log('The bill-receiver account is the AWS account that receives transferred billing');
  console.log('from downstream customer accounts via AWS Billing Transfer.\n');
  const awsProfile = await ask(
    'AWS CLI profile for your bill-receiver account (e.g., billing-admin)',
    existing.AWS_PROFILE || '',
  );

  // Auto-detect region and account
  const detectedRegion = detectRegion(awsProfile);
  const awsRegion = await ask('AWS region (e.g., us-east-1)', existing.AWS_REGION || detectedRegion);

  console.log('\nValidating credentials...');
  const detectedAccount = detectAccountId(awsProfile);
  if (detectedAccount) {
    console.log(`✅ Authenticated to account ${detectedAccount}\n`);
  } else {
    console.log('⚠️  Could not validate credentials. Check your profile and try again.\n');
  }

  const awsAccountId = await ask(
    'AWS account ID of your bill-receiver account (e.g., 123456789012)',
    existing.AWS_ACCOUNT_ID || detectedAccount,
  );

  // Bedrock model
  console.log('\nBedrock model for the billing assistant chat feature.');
  console.log('Ensure the model is enabled in Amazon Bedrock > Model access.\n');
  const bedrockModel = await ask(
    'Bedrock model ID (e.g., us.anthropic.claude-sonnet-4-20250514-v1:0)',
    existing.BEDROCK_MODEL_ID || 'us.anthropic.claude-sonnet-4-20250514-v1:0',
  );

  // Athena settings
  console.log('\n── Athena / Glue settings ──');
  console.log('These configure the data catalog for Customer Reports.');
  console.log('CDK creates these resources automatically. Press Enter to accept defaults.');
  console.log(`\n  Example defaults for your account:`);
  console.log(`    Glue database:      billing_portal_cur`);
  console.log(`    Athena results:     billing-portal-athena-results-${awsAccountId}-${awsRegion}`);
  console.log(`    CUR data bucket:    billing-portal-cur-data-${awsAccountId}-${awsRegion}`);
  console.log(`    Glue crawler:       billing-portal-cur-crawler\n`);
  const athenaDb = await ask(
    'Glue database name (e.g., billing_portal_cur)',
    existing.ATHENA_DATABASE || 'billing_portal_cur',
  );
  const athenaTable = await ask(
    'Athena table name (e.g., cur_data — auto-discovered if left as default)',
    existing.ATHENA_TABLE || 'cur_data',
  );
  const athenaResultsBucket = await ask(
    'S3 bucket for Athena query results',
    existing.ATHENA_RESULTS_BUCKET || `billing-portal-athena-results-${awsAccountId}-${awsRegion}`,
  );

  // S3 / Glue settings
  console.log('\n── S3 / Glue Crawler settings ──');
  console.log('The CUR bucket stores Cost and Usage Report data from BCM Data Exports.');
  console.log('The crawler catalogs this data so Athena can query it.\n');
  const curBucketName = await ask(
    'S3 bucket for CUR data',
    existing.CUR_BUCKET_NAME || `billing-portal-cur-data-${awsAccountId}-${awsRegion}`,
  );
  const crawlerName = await ask(
    'Glue crawler name',
    existing.GLUE_CRAWLER_NAME || 'billing-portal-cur-crawler',
  );

  // Legacy CUR (optional)
  console.log('\n── Legacy CUR (optional) ──');
  console.log('If you have an existing CUR (v1) with Parquet data in S3, provide the path.');
  console.log('This lets Customer Reports show historical data alongside new CUR 2.0 exports.');
  console.log('Leave blank if you only want CUR 2.0 data.\n');
  const legacyCurPath = await ask(
    'Legacy CUR S3 path (e.g., s3://my-cur-bucket/cur-parquet/report/report/)',
    existing.LEGACY_CUR_S3_PATH || '',
  );

  // MCP settings
  const mcpVersion = existing.MCP_SERVER_VERSION || '0.0.19';
  const mcpTimeout = existing.MCP_TIMEOUT_SECONDS || '30';

  // Write .env
  const envContent = `# Generated by setup script — ${new Date().toISOString()}
# AWS Configuration
AWS_REGION=${awsRegion}
AWS_ACCOUNT_ID=${awsAccountId}
AWS_PROFILE=${awsProfile}

# Athena / Customer Reports
ATHENA_DATABASE=${athenaDb}
ATHENA_TABLE=${athenaTable}
ATHENA_RESULTS_BUCKET=${athenaResultsBucket}

# S3 / Glue
CUR_BUCKET_NAME=${curBucketName}
GLUE_CRAWLER_NAME=${crawlerName}
${legacyCurPath ? `LEGACY_CUR_S3_PATH=${legacyCurPath}` : '# LEGACY_CUR_S3_PATH='}

# Bedrock Model
BEDROCK_MODEL_ID=${bedrockModel}

# MCP Server
MCP_SERVER_VERSION=${mcpVersion}
MCP_TIMEOUT_SECONDS=${mcpTimeout}

# Bedrock Guardrails (populated after cdk deploy)
BEDROCK_GUARDRAIL_ID=
BEDROCK_GUARDRAIL_VERSION=DRAFT
`;

  writeFileSync(ENV_PATH, envContent);
  console.log(`\n✅ .env written to ${ENV_PATH}\n`);
  console.log('Next steps:');
  console.log('  1. pnpm nx run-many --target build --all');
  console.log(`  2. AWS_PROFILE=${awsProfile} pnpm nx run @billing-partner-portal/infra:bootstrap`);
  console.log(`  3. AWS_PROFILE=${awsProfile} pnpm nx run @billing-partner-portal/infra:deploy`);
  console.log('  4. Open the CloudFront URL from the deploy output\n');

  rl.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
