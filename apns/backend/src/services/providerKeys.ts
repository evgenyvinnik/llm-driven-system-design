import crypto from "crypto";
import db from "../db/index.js";
import {
  ProviderKeyRecord,
  generateProviderKeyPair,
} from "../shared/providerToken.js";

/**
 * Provider Key Service.
 *
 * Manages the signing keys providers use to authenticate sends, mirroring the
 * APNs developer-portal flow: an admin creates a key scoped to some apps, the
 * private key is shown exactly once, and only the public key is stored.
 */

/** Provider key as listed to admins (no key material). */
export interface ProviderKeySummary {
  key_id: string;
  team_id: string;
  app_bundle_ids: string[];
  created_at: Date;
  revoked_at: Date | null;
}

const KEY_ID_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

/** Generates a 10-character key ID in the APNs format. */
function generateKeyId(): string {
  let keyId = "";
  for (let i = 0; i < 10; i++) {
    keyId += KEY_ID_ALPHABET[crypto.randomInt(KEY_ID_ALPHABET.length)];
  }
  return keyId;
}

/**
 * Creates a provider key scoped to the given apps.
 *
 * @param teamId - 10-character team identifier (the JWT `iss`)
 * @param appBundleIds - Bundle IDs the key may send to
 * @param createdBy - Admin user ID creating the key
 * @returns Key metadata plus the PEM private key, which is not stored
 */
export async function createProviderKey(
  teamId: string,
  appBundleIds: string[],
  createdBy: string
): Promise<ProviderKeySummary & { private_key: string }> {
  const { publicKey, privateKey } = generateProviderKeyPair();
  const keyId = generateKeyId();

  const result = await db.query<ProviderKeySummary>(
    `INSERT INTO provider_keys (key_id, team_id, public_key, app_bundle_ids, created_by)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING key_id, team_id, app_bundle_ids, created_at, revoked_at`,
    [keyId, teamId, publicKey, appBundleIds, createdBy]
  );

  return { ...result.rows[0], private_key: privateKey };
}

/**
 * Looks up a non-revoked key for JWT verification.
 *
 * @param keyId - The JWT `kid` header
 * @returns Key record or null if unknown or revoked
 */
export async function getActiveProviderKey(
  keyId: string
): Promise<ProviderKeyRecord | null> {
  const result = await db.query<ProviderKeyRecord>(
    `SELECT key_id, team_id, public_key, app_bundle_ids
     FROM provider_keys
     WHERE key_id = $1 AND revoked_at IS NULL`,
    [keyId]
  );
  return result.rows[0] ?? null;
}

/**
 * Lists all provider keys, newest first.
 *
 * @returns Key metadata without public or private key material
 */
export async function listProviderKeys(): Promise<ProviderKeySummary[]> {
  const result = await db.query<ProviderKeySummary>(
    `SELECT key_id, team_id, app_bundle_ids, created_at, revoked_at
     FROM provider_keys
     ORDER BY created_at DESC`
  );
  return result.rows;
}

/**
 * Revokes a provider key; tokens signed by it stop verifying immediately.
 *
 * @param keyId - Key to revoke
 * @returns True if an active key was revoked
 */
export async function revokeProviderKey(keyId: string): Promise<boolean> {
  const result = await db.query(
    `UPDATE provider_keys SET revoked_at = NOW()
     WHERE key_id = $1 AND revoked_at IS NULL`,
    [keyId]
  );
  return (result.rowCount ?? 0) > 0;
}
