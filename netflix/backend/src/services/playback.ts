/**
 * Playback authorization.
 *
 * Starting playback is the one place where every rule about *who may watch what*
 * meets: the profile's maturity level, the account's plan (quality cap and
 * concurrent-stream limit), and the relationship between an episode and its
 * series. This module keeps those rules in one place:
 *
 * - `resolvePlayable` / `loadViewer` read the title and the viewer in one query each.
 * - `evaluateEntitlement` and `qualitiesForPlan` are pure functions (unit-tested).
 * - Stream URLs carry an HMAC token bound to (session, title, quality, expiry).
 *   `/play` verifies it without touching PostgreSQL or Redis -- the same check a
 *   CDN edge performs on a tokenized URL.
 * - Concurrent streams are leases in a Redis sorted set per account
 *   (member = playback session id, score = lease expiry). Progress heartbeats
 *   renew the lease; a device that goes quiet frees its slot.
 */
import crypto from 'crypto';
import { queryOne } from '../db/index.js';
import { redis } from './redis.js';
import { streamingLogger } from './logger.js';
import { PLAYBACK_CONFIG, STREAMING_CONFIG } from '../config.js';

/** A title (or one episode of it) that a session can be opened for. */
export interface PlayableContent {
  videoId: string;
  episodeId: string | null;
  /** What is actually played: the episode for series, the movie otherwise. */
  contentId: string;
  title: string;
  maturityLevel: number;
  durationSeconds: number;
}

/** The profile and account behind a request. */
export interface Viewer {
  profileId: string;
  accountId: string;
  maturityLevel: number;
  subscriptionTier: string;
}

export type ResolveError = 'not_found' | 'episode_required' | 'episode_not_in_title';

export interface QualityRung {
  quality: string;
  bitrate: number;
  width: number;
  height: number;
}

/**
 * Looks up the content being played. For a series the episode must belong to
 * the requested title -- otherwise a profile could pass a harmless series id in
 * the path and a restricted show's episode id in the query string.
 */
export async function resolvePlayable(
  videoId: string,
  episodeId?: string | null
): Promise<PlayableContent | ResolveError> {
  if (episodeId) {
    const row = await queryOne<{
      video_id: string;
      title: string;
      maturity_level: number;
      episode_id: string;
      duration_minutes: number | null;
    }>(
      `SELECT v.id AS video_id, v.title, v.maturity_level, e.id AS episode_id, e.duration_minutes
       FROM episodes e
       JOIN seasons s ON s.id = e.season_id
       JOIN videos v ON v.id = s.video_id
       WHERE e.id = $1 AND v.id = $2`,
      [episodeId, videoId]
    );
    if (!row) {
      const title = await queryOne<{ id: string }>('SELECT id FROM videos WHERE id = $1', [videoId]);
      return title ? 'episode_not_in_title' : 'not_found';
    }
    return {
      videoId: row.video_id,
      episodeId: row.episode_id,
      contentId: row.episode_id,
      title: row.title,
      maturityLevel: row.maturity_level,
      durationSeconds: (row.duration_minutes || 45) * 60,
    };
  }

  const video = await queryOne<{
    id: string;
    title: string;
    type: 'movie' | 'series';
    maturity_level: number;
    duration_minutes: number | null;
  }>('SELECT id, title, type, maturity_level, duration_minutes FROM videos WHERE id = $1', [videoId]);

  if (!video) return 'not_found';
  if (video.type === 'series') return 'episode_required';

  return {
    videoId: video.id,
    episodeId: null,
    contentId: video.id,
    title: video.title,
    maturityLevel: video.maturity_level,
    durationSeconds: (video.duration_minutes || 120) * 60,
  };
}

/** Loads the selected profile together with its account's plan. */
export async function loadViewer(profileId: string, accountId: string): Promise<Viewer | null> {
  const row = await queryOne<{
    maturity_level: number;
    account_id: string;
    subscription_tier: string | null;
  }>(
    `SELECT p.maturity_level, a.id AS account_id, a.subscription_tier
     FROM profiles p
     JOIN accounts a ON a.id = p.account_id
     WHERE p.id = $1 AND a.id = $2`,
    [profileId, accountId]
  );
  if (!row) return null;
  return {
    profileId,
    accountId: row.account_id,
    maturityLevel: row.maturity_level,
    subscriptionTier: row.subscription_tier || 'standard',
  };
}

/** Returns the plan limits for a subscription tier (unknown tiers get the lowest plan). */
export function planFor(tier: string): { maxStreams: number; maxHeight: number } {
  return PLAYBACK_CONFIG.plans[tier] || PLAYBACK_CONFIG.plans.basic;
}

/**
 * Decides whether a viewer may play a title. Maturity is the only per-title rule
 * today; region availability and plan-exclusive titles would slot in here.
 */
export function evaluateEntitlement(
  viewer: Pick<Viewer, 'maturityLevel'>,
  content: Pick<PlayableContent, 'maturityLevel'>
): { allowed: true } | { allowed: false; reason: 'maturity_restricted' } {
  if (content.maturityLevel > viewer.maturityLevel) {
    return { allowed: false, reason: 'maturity_restricted' };
  }
  return { allowed: true };
}

/**
 * Caps a quality ladder at the plan's maximum resolution. Uses the renditions
 * recorded in `video_files` when there are any, otherwise the default ladder.
 */
export function qualitiesForPlan(tier: string, available: QualityRung[] = defaultLadder()): QualityRung[] {
  const { maxHeight } = planFor(tier);
  const allowed = available.filter((q) => q.height <= maxHeight);
  // A title encoded only above the cap still gets its lowest rendition.
  if (allowed.length === 0 && available.length > 0) {
    return [available.reduce((low, q) => (q.height < low.height ? q : low))];
  }
  return allowed.sort((a, b) => a.height - b.height);
}

function defaultLadder(): QualityRung[] {
  return STREAMING_CONFIG.qualities.map((q) => ({
    quality: q.name,
    bitrate: q.bitrate,
    width: q.width,
    height: q.height,
  }));
}

// =========================================================
// Signed stream URLs
// =========================================================

/** Everything a stream URL token is bound to. */
export interface StreamTokenClaims {
  sessionId: string;
  videoId: string;
  episodeId: string | null;
  quality: string;
  /** Unix time in seconds. */
  expiresAt: number;
}

function canonicalClaims(claims: StreamTokenClaims): string {
  return [claims.sessionId, claims.videoId, claims.episodeId ?? '', claims.quality, claims.expiresAt].join('|');
}

/** HMAC-SHA256 over the canonical claims, base64url encoded. */
export function signStreamToken(claims: StreamTokenClaims, secret = PLAYBACK_CONFIG.urlTokenSecret): string {
  return crypto.createHmac('sha256', secret).update(canonicalClaims(claims)).digest('base64url');
}

/**
 * Verifies a stream URL token in constant time. Changing any bound field
 * (another quality, another title, a later expiry) invalidates the signature.
 */
export function verifyStreamToken(
  claims: StreamTokenClaims,
  signature: string,
  nowMs = Date.now(),
  secret = PLAYBACK_CONFIG.urlTokenSecret
): 'ok' | 'invalid' | 'expired' {
  const expected = Buffer.from(signStreamToken(claims, secret));
  const given = Buffer.from(signature);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    return 'invalid';
  }
  if (!Number.isFinite(claims.expiresAt) || claims.expiresAt * 1000 <= nowMs) {
    return 'expired';
  }
  return 'ok';
}

/** Builds a relative `/play` URL (relative so it works through the Vite proxy). */
export function buildStreamUrl(claims: StreamTokenClaims): string {
  const params = new URLSearchParams({
    quality: claims.quality,
    sid: claims.sessionId,
    exp: String(claims.expiresAt),
    sig: signStreamToken(claims),
  });
  if (claims.episodeId) params.set('episodeId', claims.episodeId);
  return `/api/stream/${claims.videoId}/play?${params.toString()}`;
}

// =========================================================
// Concurrent-stream leases
// =========================================================

/**
 * Acquire-or-renew a stream slot atomically.
 * KEYS[1] = streams:{accountId}; ARGV = sessionId, nowMs, leaseMs, maxStreams.
 * Expired leases are dropped first; an existing member is always renewed (so a
 * heartbeat never loses its own slot to a newcomer); a new member is admitted
 * only while the account is under its plan's limit.
 * Returns {granted (1|0), active sessions after the call}.
 */
const ACQUIRE_SLOT_SCRIPT = `
local key = KEYS[1]
local sessionId = ARGV[1]
local now = tonumber(ARGV[2])
local leaseMs = tonumber(ARGV[3])
local maxStreams = tonumber(ARGV[4])
redis.call('ZREMRANGEBYSCORE', key, '-inf', now)
local granted = 0
if redis.call('ZSCORE', key, sessionId) then
  granted = 1
elseif redis.call('ZCARD', key) < maxStreams then
  granted = 1
end
if granted == 1 then
  redis.call('ZADD', key, now + leaseMs, sessionId)
  redis.call('PEXPIRE', key, leaseMs)
end
return {granted, redis.call('ZCARD', key)}
`;

export interface SlotResult {
  granted: boolean;
  activeStreams: number;
  limit: number;
  /** True when Redis was unavailable and the slot was granted without checking. */
  failedOpen?: boolean;
}

function slotKey(accountId: string): string {
  return `streams:${accountId}`;
}

/**
 * Claims (or renews) a stream slot for a playback session.
 * Fails open when Redis is down: a brief overage on concurrent streams is a far
 * smaller harm than refusing playback to every subscriber.
 */
export async function acquireStreamSlot(
  accountId: string,
  sessionId: string,
  maxStreams: number,
  nowMs = Date.now(),
  leaseSeconds = PLAYBACK_CONFIG.streamLeaseSeconds
): Promise<SlotResult> {
  try {
    const result = (await redis.eval(
      ACQUIRE_SLOT_SCRIPT,
      1,
      slotKey(accountId),
      sessionId,
      String(nowMs),
      String(leaseSeconds * 1000),
      String(maxStreams)
    )) as [number, number];
    return { granted: result[0] === 1, activeStreams: result[1], limit: maxStreams };
  } catch (error) {
    streamingLogger.error({ error: String(error), accountId }, 'Stream slot check failed - allowing playback');
    return { granted: true, activeStreams: 0, limit: maxStreams, failedOpen: true };
  }
}

/** Releases a stream slot. Scoped to the caller's own account, so no session can free another account's slot. */
export async function releaseStreamSlot(accountId: string, sessionId: string): Promise<boolean> {
  try {
    const removed = await redis.zrem(slotKey(accountId), sessionId);
    return removed === 1;
  } catch (error) {
    streamingLogger.error({ error: String(error), accountId }, 'Stream slot release failed');
    return false;
  }
}
