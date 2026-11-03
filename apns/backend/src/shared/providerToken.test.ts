import crypto from "crypto";
import { describe, it, expect } from "vitest";
import {
  ProviderKeyRecord,
  generateProviderKeyPair,
  looksLikeJwt,
  signProviderToken,
  verifyProviderToken,
} from "./providerToken.js";

const NOW = 1_800_000_000;
const { publicKey, privateKey } = generateProviderKeyPair();
const KEY: ProviderKeyRecord = {
  key_id: "KEY0000001",
  team_id: "TEAM000001",
  public_key: publicKey,
  app_bundle_ids: ["com.example.test"],
};

const resolveKey = async (keyId: string) => (keyId === KEY.key_id ? KEY : null);

function sign(overrides: { keyId?: string; teamId?: string; privateKey?: string; issuedAt?: number } = {}) {
  return signProviderToken({
    keyId: overrides.keyId ?? KEY.key_id,
    teamId: overrides.teamId ?? KEY.team_id,
    privateKey: overrides.privateKey ?? privateKey,
    issuedAt: overrides.issuedAt ?? NOW,
  });
}

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

describe("verifyProviderToken", () => {
  it("accepts a fresh token signed by the registered key", async () => {
    const result = await verifyProviderToken(sign(), resolveKey, NOW);
    expect(result).toEqual({ ok: true, key: KEY });
  });

  it("reports tokens older than an hour as expired", async () => {
    const result = await verifyProviderToken(sign({ issuedAt: NOW - 3601 }), resolveKey, NOW);
    expect(result).toEqual({ ok: false, reason: "ExpiredProviderToken" });
  });

  it("rejects tokens issued well in the future", async () => {
    const result = await verifyProviderToken(sign({ issuedAt: NOW + 3600 }), resolveKey, NOW);
    expect(result).toEqual({ ok: false, reason: "InvalidProviderToken" });
  });

  it("rejects a token signed by a different private key", async () => {
    const other = generateProviderKeyPair();
    const result = await verifyProviderToken(sign({ privateKey: other.privateKey }), resolveKey, NOW);
    expect(result.ok).toBe(false);
  });

  it("rejects an unknown or revoked key ID", async () => {
    const result = await verifyProviderToken(sign({ keyId: "UNKNOWN001" }), resolveKey, NOW);
    expect(result.ok).toBe(false);
  });

  it("rejects an issuer that does not own the key", async () => {
    const result = await verifyProviderToken(sign({ teamId: "TEAM999999" }), resolveKey, NOW);
    expect(result.ok).toBe(false);
  });

  it("rejects claims edited after signing", async () => {
    const [header, , signature] = sign().split(".");
    const forged = `${header}.${encode({ iss: KEY.team_id, iat: NOW + 1 })}.${signature}`;
    const result = await verifyProviderToken(forged, resolveKey, NOW);
    expect(result.ok).toBe(false);
  });

  it("rejects alg none", async () => {
    const token = `${encode({ alg: "none", kid: KEY.key_id })}.${encode({ iss: KEY.team_id, iat: NOW })}.`;
    const result = await verifyProviderToken(token, resolveKey, NOW);
    expect(result.ok).toBe(false);
  });

  it("rejects HS256 signed with the public key as the HMAC secret", async () => {
    const signingInput = `${encode({ alg: "HS256", kid: KEY.key_id })}.${encode({ iss: KEY.team_id, iat: NOW })}`;
    const mac = crypto.createHmac("sha256", publicKey).update(signingInput).digest("base64url");
    const result = await verifyProviderToken(`${signingInput}.${mac}`, resolveKey, NOW);
    expect(result.ok).toBe(false);
  });

  it("rejects malformed tokens", async () => {
    for (const token of ["", "a.b", "a.b.c", "not-a-jwt", `${encode([])}.${encode({})}.x`]) {
      const result = await verifyProviderToken(token, resolveKey, NOW);
      expect(result.ok).toBe(false);
    }
  });
});

describe("looksLikeJwt", () => {
  it("separates provider JWTs from hex session tokens", () => {
    expect(looksLikeJwt(sign())).toBe(true);
    expect(looksLikeJwt(crypto.randomBytes(32).toString("hex"))).toBe(false);
  });
});
