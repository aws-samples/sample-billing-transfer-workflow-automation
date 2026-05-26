/**
 * Post-generate patch for the OpenAPI client.
 * Adds missing AccountId type alias that the generator omits.
 */
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, 'src/generated/billing-api');
const typesFile = path.join(dir, 'types.gen.ts');
const clientFile = path.join(dir, 'client.gen.ts');

// Patch types.gen.ts — add AccountId type
let types = fs.readFileSync(typesFile, 'utf8');
if (!types.includes('export type AccountId')) {
  types = 'export type AccountId = string;\n' + types;
  fs.writeFileSync(typesFile, types);
}

// Patch client.gen.ts — add AccountId import and serializer
let client = fs.readFileSync(clientFile, 'utf8');

// Add import — look specifically in the import block
if (!/import type \{[^}]*AccountId/s.test(client)) {
  client = client.replace('AccountCost,', 'AccountCost,\n  AccountId,');
}

// Add serializer — insert before AccountCost serializer
if (!client.includes('static AccountId')) {
  client = client.replace(
    'public static AccountCost = {',
    'public static AccountId = {\n    toJson: (model: AccountId): any => model,\n    fromJson: (json: any): AccountId => json,\n  };\n\n  public static AccountCost = {',
  );
}

fs.writeFileSync(clientFile, client);
