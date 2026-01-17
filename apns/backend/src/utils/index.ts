import crypto from "crypto";
import { v4 as uuidv4 } from "uuid";

export function generateUUID(): string {
  return uuidv4();
}

export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function generateRandomToken(length: number = 32): string {
  return crypto.randomBytes(length).toString("hex");
}

export function validateDeviceToken(token: string): boolean {
  // Device tokens are 64 character hex strings
  return /^[a-fA-F0-9]{64}$/.test(token);
}

export function validateBundleId(bundleId: string): boolean {
  // Bundle IDs follow reverse domain notation
  return /^[a-zA-Z][a-zA-Z0-9-]*(\.[a-zA-Z][a-zA-Z0-9-]*)+$/.test(bundleId);
}

export function validateTopic(topic: string): boolean {
  // Topics are alphanumeric with dots and hyphens, max 200 chars
  return (
    topic.length <= 200 && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(topic)
  );
}

export function validatePayload(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") {
    return false;
  }

  const p = payload as Record<string, unknown>;

  // Must have 'aps' key
  if (!p.aps || typeof p.aps !== "object") {
    return false;
  }

  // Payload size must be under 4KB
  const payloadSize = JSON.stringify(payload).length;
  if (payloadSize > 4096) {
    return false;
  }

  return true;
}

export function validatePriority(priority: unknown): priority is 1 | 5 | 10 {
  return priority === 1 || priority === 5 || priority === 10;
}

export function parseExpiration(expiration: unknown): Date | null {
  if (!expiration) return null;

  if (typeof expiration === "number") {
    // Unix timestamp
    if (expiration === 0) return null; // 0 means immediate delivery, no storage
    return new Date(expiration * 1000);
  }

  if (typeof expiration === "string") {
    const date = new Date(expiration);
    if (isNaN(date.getTime())) return null;
    return date;
  }

  return null;
}

export function isExpired(expiration: Date | null): boolean {
  if (!expiration) return false;
  return expiration.getTime() < Date.now();
}

export function formatDate(date: Date): string {
  return date.toISOString();
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Simple password hashing for admin users (in production, use bcrypt)
export function hashPassword(password: string): string {
  return crypto.createHash("sha256").update(password).digest("hex");
}

export function verifyPassword(password: string, hash: string): boolean {
  return hashPassword(password) === hash;
}
