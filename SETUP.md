# AWS Billing Partner Portal — Setup Guide

## Prerequisites

- Node.js >= 18
- pnpm >= 9
- Python >= 3.12
- uv (Python package manager)
- AWS CLI configured with credentials
- AWS CDK CLI (`npm install -g aws-cdk`)

## Quick Start (Local Development)

```bash
# 1. Clone and install
git clone <repo-url> && cd billing-partner-portal
pnpm install && uv sync

# 2. Configure environment
cp .env.example .env
# Edit .env with your AWS account details

# 3. Deploy infrastructure (Cognito + API Gateway + S3/CloudFront)
pnpm nx run @billing-partner-portal/infra:deploy

# 4. Run locally
pnpm nx run @billing-partner-portal/portal-website:dev
```

## Deploy to AWS

```bash
# Build everything
pnpm nx run-many --target=build --all

# Bootstrap CDK (first time only)
cdk bootstrap aws://<ACCOUNT_ID>/<REGION>

# Deploy
pnpm nx run @billing-partner-portal/infra:deploy
```

The deploy outputs will include:
- CloudFront URL for the portal
- Cognito User Pool ID (create users via AWS Console)
- API Gateway endpoint

## Architecture

```
React (Cloudscape) → API Gateway → Lambda (FastAPI) → Strands Orchestrator
                                                        ├── Billing Cost Agent (MCP stdio)
                                                        ├── Transfer Billing Agent (AWS Knowledge MCP)
                                                        └── AWS Knowledge Agent (AWS Knowledge MCP)
```

## Creating Users

Users are managed via Cognito. Self-signup is disabled for security.
Create users in the AWS Console under Cognito → User Pools → billing-partner-*.
