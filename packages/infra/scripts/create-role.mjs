#!/usr/bin/env node
// Creates the BillingPortalRole in a given account
// Usage: node create-role.mjs <profile> <account-id>

import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const [profile, accountId] = process.argv.slice(2);

if (!profile || !accountId) {
  console.error('Usage: node create-role.mjs <profile> <account-id>');
  process.exit(1);
}

const roleName = 'BillingPortalRole';
const policyName = 'BillingPortalPolicy';

const trustPolicy = JSON.stringify({
  Version: '2012-10-17',
  Statement: [
    {
      Effect: 'Allow',
      Principal: { AWS: `arn:aws:iam::${accountId}:root` },
      Action: 'sts:AssumeRole',
    },
  ],
});

const run = (cmd) => {
  try {
    execSync(cmd, { stdio: 'inherit' });
  } catch {
    // ignore — role may already exist
  }
};

console.log(
  `Creating ${roleName} in account ${accountId} using profile ${profile}...`,
);

run(
  `aws iam create-role --profile ${profile} --role-name ${roleName} --assume-role-policy-document ${JSON.stringify(trustPolicy)} --description "Least-privilege role for Billing Partner Portal" --tags Key=Project,Value=BillingPartnerPortal`,
);

const policyPath = join(__dirname, '..', 'billing-portal-policy.json');
run(
  `aws iam put-role-policy --profile ${profile} --role-name ${roleName} --policy-name ${policyName} --policy-document file://${policyPath}`,
);

console.log(`✅ ${roleName} ready in ${accountId}`);
