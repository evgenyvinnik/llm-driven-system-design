import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response, NextFunction } from "express";

// Mock shared modules before import
vi.mock("../db/redis.js", () => ({
  getSession: vi.fn(),
}));
vi.mock("../services/providerKeys.js", () => ({
  getActiveProviderKey: vi.fn(),
}));

import { getSession } from "../db/redis.js";
import { getActiveProviderKey } from "../services/providerKeys.js";
import { generateProviderKeyPair, signProviderToken } from "./providerToken.js";
import {
  requireAdmin,
  requireProvider,
  allowedBundleIds,
  canAccessBundle,
} from "./auth.js";

const { publicKey, privateKey } = generateProviderKeyPair();
const KEY = {
  key_id: "KEY0000001",
  team_id: "TEAM000001",
  public_key: publicKey,
  app_bundle_ids: ["com.example.test"],
};
const SESSION = { user_id: "u1", username: "admin", role: "admin" };

function call(
  middleware: (req: Request, res: Response, next: NextFunction) => Promise<void>,
  authorization?: string
) {
  const req = { headers: authorization ? { authorization } : {}, ip: "127.0.0.1" } as Request;
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
  };
  const next = vi.fn();
  return middleware(req, res as unknown as Response, next).then(() => ({ req, res, next }));
}

beforeEach(() => {
  vi.mocked(getSession).mockReset().mockResolvedValue(null);
  vi.mocked(getActiveProviderKey).mockReset().mockResolvedValue(null);
});

describe("requireAdmin", () => {
  it("rejects a request with no session", async () => {
    const { res, next } = await call(requireAdmin);
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("rejects an unknown session token", async () => {
    const { res, next } = await call(requireAdmin, "Bearer deadbeef");
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("does not accept a provider JWT", async () => {
    vi.mocked(getActiveProviderKey).mockResolvedValue(KEY);
    const token = signProviderToken({ keyId: KEY.key_id, teamId: KEY.team_id, privateKey });
    const { res, next } = await call(requireAdmin, `Bearer ${token}`);
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("attaches the session for a valid token", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION);
    const { req, next } = await call(requireAdmin, "Bearer abc123");
    expect(next).toHaveBeenCalledWith();
    expect(req.admin).toEqual(SESSION);
    expect(req.principal).toEqual({ kind: "admin", userId: "u1", username: "admin" });
  });
});

describe("requireProvider", () => {
  it("answers APNs-style 403 MissingProviderToken on the /3 route", async () => {
    const { res, next } = await call(requireProvider("apns"));
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ reason: "MissingProviderToken" });
    expect(next).not.toHaveBeenCalled();
  });

  it("rejects a JWT whose key is unknown or revoked", async () => {
    const token = signProviderToken({ keyId: KEY.key_id, teamId: KEY.team_id, privateKey });
    const { res, next } = await call(requireProvider(), `bearer ${token}`);
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("scopes a verified provider to its key's bundles", async () => {
    vi.mocked(getActiveProviderKey).mockResolvedValue(KEY);
    const token = signProviderToken({ keyId: KEY.key_id, teamId: KEY.team_id, privateKey });
    const { req, next } = await call(requireProvider(), `bearer ${token}`);
    expect(next).toHaveBeenCalledWith();
    expect(allowedBundleIds(req.principal)).toEqual(["com.example.test"]);
    expect(canAccessBundle(req.principal, "com.example.test")).toBe(true);
    expect(canAccessBundle(req.principal, "com.example.chatapp")).toBe(false);
  });

  it("lets an admin session through unscoped for console test sends", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION);
    const { req, next } = await call(requireProvider(), "Bearer abc123");
    expect(next).toHaveBeenCalledWith();
    expect(allowedBundleIds(req.principal)).toBeUndefined();
    expect(canAccessBundle(req.principal, "com.example.chatapp")).toBe(true);
  });
});
