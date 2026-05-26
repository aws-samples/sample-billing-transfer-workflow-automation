# @billing-partner-portal/portal-website

This library was generated with [@aws/nx-plugin](https://github.com/awslabs/nx-plugin-for-aws/).

## Building

Run `pnpm exec nx build @billing-partner-portal/portal-website [--skip-nx-cache]` to build the application.

## Run dev server

Run `pnpm exec nx serve @billing-partner-portal/portal-website`

## Running unit tests

Run `pnpm exec nx test @billing-partner-portal/portal-website` to execute the unit tests via Vitest.

### Updating snapshots

To update snapshots, run the following command:

`pnpm exec nx test @billing-partner-portal/portal-website --configuration=update-snapshot`

## Run lint

Run `pnpm exec nx lint @billing-partner-portal/portal-website`

### Fixable issues

You can also automatically fix some lint errors by running the following command:

`pnpm exec nx lint @billing-partner-portal/portal-website --configuration=fix`

### Runtime config

In order to integrate with cognito or trpc backends, you need to have a `runtime-config.json` file in your `/public` website directory. You can fetch this is follows:

`pnpm exec nx run @billing-partner-portal/portal-website:load:runtime-config`

> [!IMPORTANT]
> Ensure you have AWS CLI and curl installed
> You have deployed your CDK infrastructure into the appropriate account
> You have assumed a role in the AWS account with sufficient permissions to call describe-stacks from cloudformation

## Useful links

- [React website reference docs](TODO)
- [Learn more about NX](https://nx.dev/getting-started/intro)
