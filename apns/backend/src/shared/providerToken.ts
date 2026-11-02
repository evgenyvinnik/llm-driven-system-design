/**
 * Provider Token (JWT) Module.
 *
 * Simulates APNs token-based provider authentication in its simplest form.
 * A provider holds an ES256 (P-256) private key; the service stores only the
 * matching public key. Every provider request carries
 * `Authorization: bearer <JWT>`, whose header names the signing key (`kid`)
 * and whose claims name the team (`iss`) and issue time (`iat`).
 *
 * WHY: The service must know which application a send comes from before it
 * touches a device. Asymmetric keys mean a database leak exposes no signing
 * material, and a one-hour token lifetime (the APNs rule) bounds how long a
 * stolen token is useful without making providers sign on every request.
 *
 * @module shared/providerToken
 */

import crypto from "crypto";

/** APNs rejects provider tokens issued more than an hour ago. */
export const PROVIDER_TOKEN_MAX_AGE_SECONDS = 60 * 60;

/** Tolerated clock drift for tokens issued "in the future". */
const CLOCK_SKEW_SECONDS = 5 * 60;

/** A registered provider signing key, as the verifier needs it. */
export interface ProviderKeyRecord {
  /** 10-character key identifier, sent as the JWT `kid` header */
  key_id: string;
  /** 10-character team identifier, sent as the JWT `iss` claim */
  team_id: string;
  /** PEM-encoded SPKI public key used to verify signatures */
  public_key: string;
  /** App bundle IDs this key may send to */
  app_bundle_ids: string[];
}

/** Reasons use the APNs error vocabulary so the `/3` route can return them as-is. */
export type ProviderTokenFailure = "InvalidProviderToken" | "ExpiredProviderToken";

export type ProviderTokenResult =
  | { ok: true; key: ProviderKeyRecord }
  | { ok: false; reason: ProviderTokenFailure };

const INVALID: ProviderTokenResult = { ok: false, reason: "InvalidProviderToken" };

/**
 * Distinguishes a provider JWT from a console session token.
 * Session tokens are 64-char hex; JWTs are three dot-separated segments.
 *
 * @param token - Bearer token from the Authorization header
 * @returns True if the token has JWT shape
 */
export function looksLikeJwt(token: string): boolean {
  return token.split(".").length === 3;
}

function decodeSegment(segment: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

/**
 * Verifies a provider JWT.
 * The algorithm is pinned to ES256 — the token never chooses it — so `alg:
 * "none"` and HS256-with-the-public-key confusion are both rejected.
 *
 * @param token - Compact JWT from the Authorization header
 * @param resolveKey - Looks up an active (non-revoked) key by `kid`
 * @param nowSeconds - Current Unix time, injectable for tests
 * @returns The verified key record, or the APNs reason for rejection
 */
export async function verifyProviderToken(
  token: string,
  resolveKey: (keyId: string) => Promise<ProviderKeyRecord | null>,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): Promise<ProviderTokenResult> {
  const parts = token.split(".");
  if (parts.length !== 3) return INVALID;
  const [encodedHeader, encodedClaims, encodedSignature] = parts;

  const header = decodeSegment(encodedHeader);
  const claims = decodeSegment(encodedClaims);
  if (!header || !claims) return INVALID;

  if (header.alg !== "ES256" || typeof header.kid !== "string") return INVALID;
  if (typeof claims.iss !== "string" || typeof claims.iat !== "number") return INVALID;

  const key = await resolveKey(header.kid);
  if (!key || key.team_id !== claims.iss) return INVALID;

  let signatureValid = false;
  try {
    signatureValid = crypto.verify(
      "sha256",
      Buffer.from(`${encodedHeader}.${encodedClaims}`),
      { key: key.public_key, dsaEncoding: "ieee-p1363" },
      Buffer.from(encodedSignature, "base64url")
    );
  } catch {
    signatureValid = false;
  }
  if (!signatureValid) return INVALID;

  if (claims.iat > nowSeconds + CLOCK_SKEW_SECONDS) return INVALID;
  if (nowSeconds - claims.iat > PROVIDER_TOKEN_MAX_AGE_SECONDS) {
    return { ok: false, reason: "ExpiredProviderToken" };
  }

  return { ok: true, key };
}

/**
 * Signs a provider JWT, as a provider's own server would.
 * Used by the `provider:token` script and tests; the API never signs.
 *
 * @param params - Key ID, team ID, PEM private key, optional issue time
 * @returns Compact JWT string
 */
export function signProviderToken(params: {
  keyId: string;
  teamId: string;
  privateKey: string;
  issuedAt?: number;
}): string {
  const header = Buffer.from(
    JSON.stringify({ alg: "ES256", kid: params.keyId })
  ).toString("base64url");
  const claims = Buffer.from(
    JSON.stringify({
      iss: params.teamId,
      iat: params.issuedAt ?? Math.floor(Date.now() / 1000),
    })
  ).toString("base64url");
  const signature = crypto.sign("sha256", Buffer.from(`${header}.${claims}`), {
    key: params.privateKey,
    dsaEncoding: "ieee-p1363",
  });
  return `${header}.${claims}.${signature.toString("base64url")}`;
}

/**
 * Generates a P-256 key pair for a new provider key.
 * The private key is handed to the provider once and never stored.
 *
 * @returns PEM-encoded public (SPKI) and private (PKCS#8) keys
 */
export function generateProviderKeyPair(): { publicKey: string; privateKey: string } {
  return crypto.generateKeyPairSync("ec", {
    namedCurve: "P-256",
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
}
