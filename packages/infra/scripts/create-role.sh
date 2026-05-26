#!/bin/bash
# Creates the BillingPortalRole in a given account
# Usage: ./create-role.sh <profile> <account-id>

set -euo pipefail

PROFILE=$1
ACCOUNT_ID=$2
ROLE_NAME="BillingPortalRole"
POLICY_NAME="BillingPortalPolicy"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "Creating $ROLE_NAME in account $ACCOUNT_ID using profile $PROFILE..."

# Trust policy — allow same-account role assumption via Isengard
TRUST_POLICY=$(cat <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "AWS": "arn:aws:iam::${ACCOUNT_ID}:root" },
      "Action": "sts:AssumeRole"
    }
  ]
}
EOF
)

# Create role
aws iam create-role \
  --profile "$PROFILE" \
  --role-name "$ROLE_NAME" \
  --assume-role-policy-document "$TRUST_POLICY" \
  --description "Least-privilege role for Billing Partner Portal — read billing data + invoke Bedrock" \
  --tags Key=Project,Value=BillingPartnerPortal \
  2>/dev/null || echo "  Role already exists, updating policy..."

# Put inline policy
aws iam put-role-policy \
  --profile "$PROFILE" \
  --role-name "$ROLE_NAME" \
  --policy-name "$POLICY_NAME" \
  --policy-document "file://${SCRIPT_DIR}/../billing-portal-policy.json"

echo "✅ $ROLE_NAME ready in $ACCOUNT_ID"
