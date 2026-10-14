/**
 * Resume-position writes.
 *
 * A playing client reports its position every few seconds, and several devices
 * can report for the same profile and title. Requests arrive late, out of order
 * and retried, so "apply whatever arrives" would move resume points backwards.
 * Each write therefore carries the time the position was observed, and the row
 * keeps the newest one: last writer wins by position timestamp, not by arrival.
 *
 * The same rule makes writes idempotent -- a retried ping carries the same
 * timestamp, is not newer than what is stored, and changes nothing -- and it
 * lets `watch_history` record exactly one view per transition to "completed".
 */
import type { PoolClient } from 'pg';
import { transaction } from '../db/index.js';
import { PLAYBACK_CONFIG } from '../config.js';

/** Content counts as watched past this fraction (nobody watches the credits). */
export const COMPLETION_THRESHOLD = 0.95;

export interface ProgressWrite {
  profileId: string;
  /** The title: the movie, or the series the episode belongs to. */
  videoId: string;
  episodeId: string | null;
  positionSeconds: number;
  durationSeconds: number;
  /** When the client observed this position (the last-writer-wins clock). */
  positionTimestamp: Date;
}

export interface ProgressWriteResult {
  /** False when an equal-or-newer position was already stored (retry or late arrival). */
  applied: boolean;
  completed: boolean;
  /** Position stored after this write. */
  positionSeconds: number;
  /** The item entered, left or re-entered Continue Watching (homepage cache must be refreshed). */
  continueWatchingChanged: boolean;
  /** A watch_history row was written by this request. */
  historyRecorded: boolean;
}

/**
 * True once more than 95% of the content has been played.
 */
export function isProgressComplete(position: number, duration: number): boolean {
  if (duration <= 0) return false;
  return position / duration > COMPLETION_THRESHOLD;
}

/**
 * Turns the client's timestamp into the stored LWW clock. Missing timestamps
 * (older clients) use server time; timestamps from a clock running far ahead
 * are clamped, or that device's writes would beat every other device forever.
 */
export function resolvePositionTimestamp(
  clientTimestampMs: number | undefined,
  nowMs = Date.now(),
  maxSkewMs = PLAYBACK_CONFIG.maxClockSkewMs
): Date {
  if (clientTimestampMs === undefined || !Number.isFinite(clientTimestampMs)) {
    return new Date(nowMs);
  }
  return new Date(Math.min(clientTimestampMs, nowMs + maxSkewMs));
}

async function recordHistory(client: PoolClient, write: ProgressWrite): Promise<void> {
  await client.query(
    `INSERT INTO watch_history (profile_id, video_id, episode_id, watched_at)
     VALUES ($1, $2, $3, NOW())`,
    [write.profileId, write.videoId, write.episodeId]
  );
}

/**
 * Creates the progress row if this (profile, content) has none yet.
 * Returns the write result when a row was created, or null when one already existed.
 */
async function insertIfAbsent(
  client: PoolClient,
  write: ProgressWrite,
  completed: boolean
): Promise<ProgressWriteResult | null> {
  const inserted = await client.query(
    `INSERT INTO viewing_progress
       (profile_id, video_id, episode_id, position_seconds, duration_seconds, completed, client_updated_at, last_watched_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
     ON CONFLICT (profile_id, content_id) DO NOTHING
     RETURNING id`,
    [
      write.profileId,
      write.videoId,
      write.episodeId,
      write.positionSeconds,
      write.durationSeconds,
      completed,
      write.positionTimestamp,
    ]
  );
  if (inserted.rowCount !== 1) return null;

  if (completed) await recordHistory(client, write);
  return {
    applied: true,
    completed,
    positionSeconds: write.positionSeconds,
    continueWatchingChanged: true,
    historyRecorded: completed,
  };
}

/**
 * Applies one progress report under last-writer-wins.
 *
 * 1. Try to create the row; `ON CONFLICT DO NOTHING` reports whether it existed.
 * 2. Otherwise lock it (`FOR UPDATE`) and compare position timestamps; an older
 *    or equal timestamp is a no-op.
 * 3. A not-completed -> completed transition writes watch_history in the same
 *    transaction, so a crash can't record the view without the position (or the
 *    reverse), and concurrent pings can't both record it.
 */
export async function recordProgress(write: ProgressWrite): Promise<ProgressWriteResult> {
  const completed = isProgressComplete(write.positionSeconds, write.durationSeconds);

  return transaction(async (client) => {
    const created = await insertIfAbsent(client, write, completed);
    if (created) return created;

    const current = await client.query<{
      id: string;
      position_seconds: number;
      completed: boolean;
      client_updated_at: Date | null;
    }>(
      `SELECT id, position_seconds, completed, client_updated_at
       FROM viewing_progress
       WHERE profile_id = $1 AND content_id = $2
       FOR UPDATE`,
      [write.profileId, write.episodeId ?? write.videoId]
    );
    const row = current.rows[0];
    if (!row) {
      // Deleted between the two statements (retention job, profile removal): create it again.
      const recreated = await insertIfAbsent(client, write, completed);
      if (recreated) return recreated;
      throw new Error('viewing_progress row vanished and reappeared during the write');
    }

    if (row.client_updated_at && row.client_updated_at.getTime() >= write.positionTimestamp.getTime()) {
      return {
        applied: false,
        completed: row.completed,
        positionSeconds: row.position_seconds,
        continueWatchingChanged: false,
        historyRecorded: false,
      };
    }

    await client.query(
      `UPDATE viewing_progress
       SET video_id = $2, position_seconds = $3, duration_seconds = $4, completed = $5,
           client_updated_at = $6, last_watched_at = NOW()
       WHERE id = $1`,
      [row.id, write.videoId, write.positionSeconds, write.durationSeconds, completed, write.positionTimestamp]
    );

    const newlyCompleted = completed && !row.completed;
    if (newlyCompleted) await recordHistory(client, write);

    return {
      applied: true,
      completed,
      positionSeconds: write.positionSeconds,
      continueWatchingChanged: completed !== row.completed,
      historyRecorded: newlyCompleted,
    };
  });
}
