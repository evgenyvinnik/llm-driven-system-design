/**
 * Shared helper functions for moderation routes.
 *
 * Provides authentication and authorization utilities used across
 * all moderation route handlers.
 *
 * @module routes/moderation/helpers
 */
import type { Request, Response } from 'express';
import { query } from '../../services/database.js';
import { getSession } from '../../services/redis.js';
import type { ModeratorAccessResult, UserRow, RoleRow } from './types.js';

/**
 * Checks if a user has moderator-level access to a channel.
 *
 * Access is granted if the user is:
 * - The channel owner
 * - An assigned moderator for the channel
 * - A platform admin
 *
 * @description Determines the user's access role for a given channel
 * @param userId - The numeric ID of the user to check
 * @param channelId - The string ID of the channel to check access for
 * @returns A promise resolving to an object with hasAccess boolean and role string
 *
 * @example
 * const access = await checkModeratorAccess(123, '456');
 * if (access.hasAccess) {
 *   console.log(`User has access as ${access.role}`);
 * }
 */
export async function checkModeratorAccess(
  userId: number,
  channelId: string
): Promise<ModeratorAccessResult> {
  // Check if channel owner
  const ownerCheck = await query(
    'SELECT 1 FROM channels WHERE id = $1 AND user_id = $2',
    [channelId, userId]
  );
  if (ownerCheck.rows.length > 0) {
    return { hasAccess: true, role: 'owner' };
  }
  // Check if moderator
  const modCheck = await query(
    'SELECT 1 FROM channel_moderators WHERE channel_id = $1 AND user_id = $2',
    [channelId, userId]
  );
  if (modCheck.rows.length > 0) {
    return { hasAccess: true, role: 'moderator' };
  }
  // Check if admin
  const adminCheck = await query<RoleRow>('SELECT role FROM users WHERE id = $1', [userId]);
  if (adminCheck.rows[0]?.role === 'admin') {
    return { hasAccess: true, role: 'admin' };
  }
  return { hasAccess: false, role: null };
}

/**
 * Retrieves the username for a given user ID.
 *
 * @description Fetches the username from the database by user ID
 * @param userId - The numeric ID of the user
 * @returns A promise resolving to the username string, or 'unknown' if not found
 *
 * @example
 * const username = await getUsername(123);
 * console.log(`User is: ${username}`);
 */
export async function getUsername(userId: number): Promise<string> {
  const result = await query<UserRow>('SELECT username FROM users WHERE id = $1', [userId]);
  return result.rows[0]?.username || 'unknown';
}

/**
 * Authenticate request and return actor ID, or send error response
 */
export async function authenticateRequest(
  req: Request,
  res: Response
): Promise<number | null> {
  const sessionId = req.cookies.session as string | undefined;
  if (!sessionId) {
    res.status(401).json({ error: 'Not authenticated' });
    return null;
  }
  const actorId = await getSession(sessionId);
  if (!actorId) {
    res.status(401).json({ error: 'Session expired' });
    return null;
  }
  return actorId;
}

/**
 * Check moderator access and return result, or send error response
 */
export async function requireModeratorAccess(
  actorId: number,
  channelId: string,
  res: Response
): Promise<boolean> {
  const { hasAccess } = await checkModeratorAccess(actorId, channelId);
  if (!hasAccess) {
    res.status(403).json({ error: 'Not authorized to moderate this channel' });
    return false;
  }
  return true;
}
