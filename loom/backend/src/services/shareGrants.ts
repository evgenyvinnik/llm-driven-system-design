import crypto from 'crypto';
import type { Request, Response } from 'express';
import { config } from '../config/index.js';

/**
 * Share grants: proof that this browser opened a share link (and passed its password).
 *
 * The grant is a signed cookie, not server state. It names the share and the video, so
 * later requests (playback URL refresh, view heartbeats, reading comments) don't repeat
 * the bcrypt check. Every use still re-reads the share row (see videoAccess.ts), so
 * revoking or expiring a share ends access immediately even though the cookie lives on.
 */
export const SHARE_GRANT_COOKIE = 'loom_share_grants';
const MAX_GRANTS = 20;

export interface ShareGrant {
  /** Share id (shares.id). */
  s: string;
  /** Video id the share points at. */
  v: string;
  /** Expiry, epoch milliseconds. */
  e: number;
}

function sign(payload: string): string {
  return crypto.createHmac('sha256', config.shareGrant.secret).update(payload).digest('base64url');
}

/** Serializes grants into `payload.signature`. */
export function encodeGrants(grants: ShareGrant[]): string {
  const payload = Buffer.from(JSON.stringify(grants)).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

/** Parses and verifies a cookie value; tampered, malformed or expired entries are dropped. */
export function decodeGrants(value: string | undefined, now: number = Date.now()): ShareGrant[] {
  if (!value) return [];
  const dot = value.lastIndexOf('.');
  if (dot <= 0) return [];
  const payload = value.slice(0, dot);
  const given = Buffer.from(value.slice(dot + 1));
  const expected = Buffer.from(sign(payload));
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return [];
  try {
    const parsed: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (g): g is ShareGrant =>
        typeof g?.s === 'string' && typeof g?.v === 'string' && typeof g?.e === 'number' && g.e > now,
    );
  } catch {
    return [];
  }
}

/** Reads one cookie from the raw header (the app has no cookie-parser). */
function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) {
      try {
        return decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

/** Valid grants carried by this request. */
export function readGrants(req: Request): ShareGrant[] {
  return decodeGrants(readCookie(req, SHARE_GRANT_COOKIE));
}

/** Share ids this request holds a grant for on the given video. */
export function grantedShareIds(req: Request, videoId: string): string[] {
  return readGrants(req)
    .filter((g) => g.v === videoId)
    .map((g) => g.s);
}

/**
 * Adds (or refreshes) a grant for a share. The grant never outlives the share's own
 * expiry, and the cookie keeps only the most recent grants.
 */
export function issueGrant(
  req: Request,
  res: Response,
  share: { id: string; videoId: string; expiresAt: Date | null },
  now: number = Date.now(),
): void {
  let expiry = now + config.shareGrant.ttlMs;
  if (share.expiresAt) expiry = Math.min(expiry, share.expiresAt.getTime());
  const others = readGrants(req).filter((g) => g.s !== share.id);
  const grants = [...others, { s: share.id, v: share.videoId, e: expiry }].slice(-MAX_GRANTS);
  res.cookie(SHARE_GRANT_COOKIE, encodeGrants(grants), {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.nodeEnv === 'production',
    path: '/api',
    maxAge: config.shareGrant.ttlMs,
  });
}
