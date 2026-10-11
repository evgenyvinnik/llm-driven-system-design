import { logger } from './logger.js';
import { getPresignedDownloadUrl } from './storageService.js';
import type { VideoRole } from './videoAccess.js';

/**
 * API shape of a video row. Viewers (share-link holders) get the public fields only;
 * object keys and failure details are the owner's business.
 */
export function mapVideoRow(row: Record<string, unknown>, role: VideoRole = 'owner') {
  const base = {
    id: row.id,
    userId: row.user_id,
    title: row.title,
    description: row.description,
    durationSeconds: row.duration_seconds,
    status: row.status,
    fileSizeBytes: row.file_size_bytes,
    viewCount: row.view_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    access: role,
  };
  if (role !== 'owner') return base;
  return {
    ...base,
    storagePath: row.storage_path,
    thumbnailPath: row.thumbnail_path,
    failureReason: row.failure_reason ?? null,
  };
}

/**
 * Attaches a presigned GET URL for each row's thumbnail.
 *
 * Thumbnails live in MinIO like the videos do, so the client can't render
 * `thumbnail_path` directly — it's an object key, not a URL. With the client's region
 * configured, presigning is local HMAC work with no round trip to storage, so doing it
 * per row while building the list response is cheap and saves the client N requests.
 */
export async function withThumbnailUrls(rows: Record<string, unknown>[], role: VideoRole = 'owner') {
  return Promise.all(
    rows.map(async (row) => {
      const mapped = mapVideoRow(row, role);
      if (!row.thumbnail_path) return { ...mapped, thumbnailUrl: null };
      try {
        return {
          ...mapped,
          thumbnailUrl: await getPresignedDownloadUrl(row.thumbnail_path as string),
        };
      } catch (err) {
        logger.warn({ err, path: row.thumbnail_path }, 'Failed to presign thumbnail');
        return { ...mapped, thumbnailUrl: null };
      }
    }),
  );
}
