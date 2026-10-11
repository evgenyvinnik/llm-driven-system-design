import { pool } from './db.js';
import { config } from '../config/index.js';
import { logger } from './logger.js';
import {
  startMultipartUpload,
  getPresignedPartUrl,
  listUploadedParts,
  completeMultipartUpload,
  abortMultipartUpload,
  getObjectStat,
  isNotFoundError,
} from './storageService.js';
import { enqueueJob } from './jobQueue.js';

/**
 * The upload lifecycle, as a state machine on `videos.status`:
 *
 *   uploading --complete, object verified--> processing --worker--> ready
 *   uploading --no part requested for N minutes--> failed (sweeper)
 *
 * The browser streams recording chunks straight to object storage as multipart parts
 * while it records; the API only hands out presigned part URLs. When recording stops
 * at most one small part is left, so completion is a single short call.
 */

/** An error that maps to an HTTP status and a client-facing message. */
export class UploadError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export const VIDEO_CONTENT_TYPE = 'video/webm';

/** Object key for a video's original upload. Deterministic, so retries reuse it. */
export function sourceObjectKey(userId: string, videoId: string): string {
  return `${userId}/${videoId}/source.webm`;
}

interface UploadRow {
  id: string;
  status: string;
  storage_path: string | null;
  upload_id: string | null;
}

async function loadOwnedVideo(videoId: string, userId: string): Promise<UploadRow & Record<string, unknown>> {
  const { rows } = await pool.query('SELECT * FROM videos WHERE id = $1 AND user_id = $2', [
    videoId,
    userId,
  ]);
  if (!rows[0]) throw new UploadError(404, 'Video not found');
  return rows[0];
}

/**
 * Opens a multipart upload for a video in `uploading`. Idempotent: a second call returns
 * the upload already open. If two calls race, the conditional UPDATE picks one winner
 * and the loser aborts the multipart upload it opened.
 */
export async function startUpload(videoId: string, userId: string) {
  const video = await loadOwnedVideo(videoId, userId);
  if (video.status !== 'uploading') {
    throw new UploadError(409, `Video is ${video.status}, not accepting uploads`);
  }
  const base = { partSize: config.upload.partSizeBytes, maxParts: config.upload.maxParts };
  if (video.upload_id && video.storage_path) {
    return { ...base, uploadId: video.upload_id, objectName: video.storage_path, created: false };
  }

  const objectName = sourceObjectKey(userId, videoId);
  const uploadId = await startMultipartUpload(objectName, VIDEO_CONTENT_TYPE);
  const claimed = await pool.query(
    `UPDATE videos
     SET upload_id = $1, storage_path = $2, upload_activity_at = NOW(), updated_at = NOW()
     WHERE id = $3 AND status = 'uploading' AND upload_id IS NULL
     RETURNING id`,
    [uploadId, objectName, videoId],
  );
  if (claimed.rows.length === 0) {
    await abortMultipartUpload(objectName, uploadId).catch((err) =>
      logger.warn({ err, videoId }, 'Failed to abort losing multipart upload'),
    );
    const current = await loadOwnedVideo(videoId, userId);
    if (current.status !== 'uploading' || !current.upload_id || !current.storage_path) {
      throw new UploadError(409, `Video is ${current.status}, not accepting uploads`);
    }
    return { ...base, uploadId: current.upload_id, objectName: current.storage_path, created: false };
  }
  return { ...base, uploadId, objectName, created: true };
}

/**
 * Presigns the PUT for one part. Each call also bumps `upload_activity_at`, which is the
 * clock the sweeper uses: an upload is abandoned when nobody has asked for a part URL
 * for a while, however long the recording itself has been running.
 */
export async function presignPart(videoId: string, userId: string, partNumber: unknown) {
  if (
    typeof partNumber !== 'number' ||
    !Number.isInteger(partNumber) ||
    partNumber < 1 ||
    partNumber > config.upload.maxParts
  ) {
    throw new UploadError(400, `partNumber must be an integer from 1 to ${config.upload.maxParts}`);
  }
  const { rows } = await pool.query(
    `UPDATE videos SET upload_activity_at = NOW()
     WHERE id = $1 AND user_id = $2 AND status = 'uploading' AND upload_id IS NOT NULL
     RETURNING storage_path, upload_id`,
    [videoId, userId],
  );
  if (!rows[0]) {
    const video = await loadOwnedVideo(videoId, userId);
    throw new UploadError(409, video.status === 'uploading' ? 'Upload not started' : `Video is ${video.status}`);
  }
  const url = await getPresignedPartUrl(rows[0].storage_path, rows[0].upload_id, partNumber);
  return { url, partNumber, expiresInSeconds: config.upload.partUrlTtlSeconds };
}

/** Parts storage already holds, so a client can resume without re-sending them. */
export async function listParts(videoId: string, userId: string) {
  const video = await loadOwnedVideo(videoId, userId);
  if (video.status !== 'uploading' || !video.upload_id || !video.storage_path) {
    throw new UploadError(409, `Video is ${video.status}, no upload in progress`);
  }
  const parts = await listUploadedParts(video.storage_path, video.upload_id);
  return parts.map((p) => ({ partNumber: p.part, size: p.size }));
}

/**
 * Checks that storage holds exactly parts 1..expected and that every part but the last
 * meets the multipart minimum. Returns a client-facing reason, or null when complete.
 */
export function findPartProblems(
  parts: { part: number; size: number }[],
  expected: number,
  minPartSize: number = config.upload.partSizeBytes,
): { reason: string; missingParts?: number[] } | null {
  const present = new Set(parts.map((p) => p.part));
  const missingParts: number[] = [];
  for (let n = 1; n <= expected; n++) if (!present.has(n)) missingParts.push(n);
  if (missingParts.length > 0) return { reason: 'Upload incomplete', missingParts };
  const extra = parts.filter((p) => p.part > expected);
  if (extra.length > 0) return { reason: `Storage holds ${extra.length} part(s) beyond partCount` };
  const small = parts.filter((p) => p.part < expected && p.size < minPartSize);
  if (small.length > 0) {
    return { reason: `Parts below the minimum size: ${small.map((p) => p.part).join(', ')}` };
  }
  return null;
}

/**
 * Finishes an upload. Storage, not the client, is the authority on what was uploaded:
 * the server lists the parts itself, checks they are contiguous, stitches them, then
 * stats the object before flipping the row to `processing` and enqueueing the job in the
 * same transaction. Calling it again after success returns the same video (idempotent).
 */
export async function completeUpload(
  videoId: string,
  userId: string,
  input: { partCount?: unknown; durationSeconds?: unknown },
) {
  const video = await loadOwnedVideo(videoId, userId);
  if (video.status === 'processing' || video.status === 'ready') {
    return { video, replayed: true };
  }
  if (video.status !== 'uploading') {
    throw new UploadError(409, `Video is ${video.status}`);
  }
  if (!video.upload_id || !video.storage_path) {
    throw new UploadError(409, 'Upload not started');
  }
  const partCount = input.partCount;
  if (
    partCount !== undefined &&
    (typeof partCount !== 'number' || !Number.isInteger(partCount) || partCount < 1)
  ) {
    throw new UploadError(400, 'partCount must be a positive integer');
  }
  const duration =
    typeof input.durationSeconds === 'number' &&
    Number.isFinite(input.durationSeconds) &&
    input.durationSeconds >= 0
      ? Math.round(input.durationSeconds)
      : null;

  let stitched = false;
  try {
    const parts = await listUploadedParts(video.storage_path, video.upload_id);
    const expected = (partCount as number | undefined) ?? parts.length;
    if (expected === 0) throw new UploadError(409, 'No parts uploaded');
    const problem = findPartProblems(parts, expected);
    if (problem) {
      const details = problem.missingParts ? { missingParts: problem.missingParts } : undefined;
      throw new UploadError(409, problem.reason, details);
    }
    await completeMultipartUpload(
      video.storage_path,
      video.upload_id,
      parts.map((p) => ({ part: p.part, etag: p.etag })),
    );
    stitched = true;
  } catch (err) {
    // A concurrent complete may have stitched the parts first, which closes the upload.
    if (!isNotFoundError(err)) throw err;
  }

  let size: number;
  try {
    size = (await getObjectStat(video.storage_path)).size;
  } catch (err) {
    if (isNotFoundError(err)) {
      throw new UploadError(409, stitched ? 'Object missing after completion' : 'Upload not found in storage');
    }
    throw err;
  }
  if (size === 0) throw new UploadError(409, 'Uploaded object is empty');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const updated = await client.query(
      `UPDATE videos
       SET status = 'processing', source_path = storage_path, upload_id = NULL,
           upload_activity_at = NULL, file_size_bytes = $2,
           duration_seconds = COALESCE($3, duration_seconds), updated_at = NOW()
       WHERE id = $1 AND status = 'uploading'
       RETURNING *`,
      [videoId, size, duration],
    );
    if (updated.rows.length === 0) {
      await client.query('ROLLBACK');
      return { video: await loadOwnedVideo(videoId, userId), replayed: true };
    }
    // The job row commits with the status change: no "ready but never processed" gap.
    await enqueueJob(client, videoId, 'process_upload');
    await client.query('COMMIT');
    return { video: updated.rows[0], replayed: false };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Aborts an open multipart upload; used when a video is discarded mid-upload. */
export async function abortUploadFor(video: { storage_path?: unknown; upload_id?: unknown }): Promise<void> {
  if (typeof video.upload_id === 'string' && typeof video.storage_path === 'string') {
    await abortMultipartUpload(video.storage_path, video.upload_id);
  }
}

/**
 * Marks abandoned uploads failed and aborts their multipart uploads so storage doesn't
 * keep paying for orphaned parts. The claim is one UPDATE over rows locked with
 * SKIP LOCKED, so several API instances can sweep at once without double work; the
 * storage calls happen after the claim, outside any transaction.
 */
export async function sweepStaleUploads(
  staleAfterMinutes: number = config.upload.staleAfterMinutes,
  limit = 50,
): Promise<{ swept: number; aborted: number }> {
  const { rows } = await pool.query(
    `WITH stale AS (
       SELECT id, upload_id, storage_path FROM videos
       WHERE status = 'uploading'
         AND COALESCE(upload_activity_at, created_at) < NOW() - make_interval(mins => $1::int)
       ORDER BY COALESCE(upload_activity_at, created_at)
       LIMIT $2
       FOR UPDATE SKIP LOCKED
     )
     UPDATE videos v
     SET status = 'failed', upload_id = NULL, upload_activity_at = NULL, updated_at = NOW(),
         failure_reason = 'Upload abandoned: no parts received for ' || $1::int || ' minutes'
     FROM stale
     WHERE v.id = stale.id
     RETURNING v.id, stale.upload_id, stale.storage_path`,
    [staleAfterMinutes, limit],
  );

  let aborted = 0;
  for (const row of rows) {
    if (!row.upload_id || !row.storage_path) continue;
    try {
      await abortMultipartUpload(row.storage_path, row.upload_id);
      aborted++;
    } catch (err) {
      // Production buckets also carry an AbortIncompleteMultipartUpload lifecycle rule.
      logger.warn({ err, videoId: row.id }, 'Failed to abort abandoned multipart upload');
    }
  }
  return { swept: rows.length, aborted };
}
