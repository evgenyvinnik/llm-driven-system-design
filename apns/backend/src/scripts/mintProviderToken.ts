/**
 * Mints a provider JWT from a key file, as a provider's server would.
 *
 * Usage: npm run -s provider:token -- provider-key.json
 *
 * The key file is the JSON returned by POST /api/v1/admin/provider-keys
 * (`key_id`, `team_id`, `private_key`). The printed token is valid for an
 * hour; send it as `Authorization: bearer <token>`.
 *
 * @module scripts/mintProviderToken
 */

import fs from "fs";
import { signProviderToken } from "../shared/providerToken.js";

const keyFile = process.argv[2];
if (!keyFile) {
  console.error("Usage: npm run -s provider:token -- <provider-key.json>");
  process.exit(1);
}

const { key_id, team_id, private_key } = JSON.parse(fs.readFileSync(keyFile, "utf-8"));
if (!key_id || !team_id || !private_key) {
  console.error(`${keyFile} must contain key_id, team_id, and private_key`);
  process.exit(1);
}

console.log(signProviderToken({ keyId: key_id, teamId: team_id, privateKey: private_key }));
