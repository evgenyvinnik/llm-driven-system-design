import type { Request, Response, NextFunction } from 'express';
import { pool } from './db.js';
import { grantedShareIds } from './shareGrants.js';

/**
 * One rule for who may see a video: its owner, or a browser holding a grant for a
 * share of it that still exists and hasn't expired. Every read path (metadata,
 * playback URL, comments, view tracking) goes through here, so revoking a share
 * cuts off all of them at once.
 */
export type VideoRole = 'owner' | 'viewer';

export interface VideoAccess {
  video: Record<string, unknown>;
  role: VideoRole;
  /** The share that granted access, for viewers. */
  shareId?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True for a syntactically valid UUID; anything else can't be a row id. */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/** Resolves the caller's access to a video, or null when they have none (or it doesn't exist). */
export async function resolveVideoAccess(req: Request, videoId: string): Promise<VideoAccess | null> {
  if (!isUuid(videoId)) return null;

  const { rows } = await pool.query('SELECT * FROM videos WHERE id = $1', [videoId]);
  const video = rows[0];
  if (!video) return null;

  if (req.session?.userId && video.user_id === req.session.userId) {
    return { video, role: 'owner' };
  }

  const shareIds = grantedShareIds(req, videoId).filter(isUuid);
  if (shareIds.length === 0) return null;

  // The grant only proves the browser once had the link; the share row decides
  // whether that still counts.
  const live = await pool.query(
    `SELECT id FROM shares
     WHERE id = ANY($1::uuid[]) AND video_id = $2
       AND (expires_at IS NULL OR expires_at > NOW())
     LIMIT 1`,
    [shareIds, videoId],
  );
  if (live.rows.length === 0) return null;
  return { video, role: 'viewer', shareId: live.rows[0].id };
}

declare module 'express-serve-static-core' {
  interface Locals {
    videoAccess?: VideoAccess;
  }
}

/**
 * Route guard: 404 unless the caller has at least `level` access to the video named by
 * `req.params[param]`. Not revealing whether the video exists is deliberate.
 */
export function requireVideoAccess(level: VideoRole, param = 'videoId') {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const access = await resolveVideoAccess(req, req.params[param]);
      if (!access || (level === 'owner' && access.role !== 'owner')) {
        res.status(404).json({ error: 'Video not found' });
        return;
      }
      res.locals.videoAccess = access;
      next();
    } catch (err) {
      next(err);
    }
  };
}
