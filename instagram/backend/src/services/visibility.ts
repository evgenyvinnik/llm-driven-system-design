/**
 * Who may see a post (and everything hanging off it: comments, likes, replies).
 *
 * - Authors always see their own posts, in any state.
 * - Everyone else only sees published posts; 'processing' and 'failed' posts have no media yet.
 * - Posts from private accounts are visible to approved followers only.
 * - Admins can see everything (moderation).
 *
 * Callers answer 404 rather than 403 when this says no, so a post id can't be used to probe
 * whether a private account posted something.
 */
import { query } from './db.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (value: unknown): value is string => typeof value === 'string' && UUID_RE.test(value);

export interface PostAccess {
  postId: string;
  authorId: string;
  status: string;
  authorIsPrivate: boolean;
}

export interface Viewer {
  userId?: string;
  role?: string;
}

/** True when `viewer` follows `authorId` (or is the author). */
export async function followsAuthor(viewerId: string | undefined, authorId: string): Promise<boolean> {
  if (!viewerId) return false;
  if (viewerId === authorId) return true;
  const result = await query('SELECT 1 FROM follows WHERE follower_id = $1 AND following_id = $2', [viewerId, authorId]);
  return result.rows.length > 0;
}

/** Public accounts are visible to everyone; private ones to the owner, followers and admins. */
export async function canViewAuthor(viewer: Viewer, authorId: string, authorIsPrivate: boolean): Promise<boolean> {
  if (!authorIsPrivate || viewer.role === 'admin') return true;
  return followsAuthor(viewer.userId, authorId);
}

export async function canViewPost(viewer: Viewer, access: Omit<PostAccess, 'postId'>): Promise<boolean> {
  if (viewer.userId && viewer.userId === access.authorId) return true;
  if (viewer.role === 'admin') return true;
  if (access.status !== 'published') return false;
  return canViewAuthor(viewer, access.authorId, access.authorIsPrivate);
}

/** Loads the fields that decide visibility, or null for an unknown or malformed id. */
export async function loadPostAccess(postId: string): Promise<PostAccess | null> {
  if (!isUuid(postId)) return null;
  const result = await query<{ user_id: string; status: string; is_private: boolean }>(
    `SELECT p.user_id, p.status, u.is_private
     FROM posts p JOIN users u ON u.id = p.user_id
     WHERE p.id = $1`,
    [postId]
  );
  const row = result.rows[0];
  return row ? { postId, authorId: row.user_id, status: row.status, authorIsPrivate: row.is_private } : null;
}

/** The post's access record when `viewer` may see it, otherwise null (treat as 404). */
export async function findVisiblePost(postId: string, viewer: Viewer): Promise<PostAccess | null> {
  const access = await loadPostAccess(postId);
  if (!access) return null;
  return (await canViewPost(viewer, access)) ? access : null;
}
