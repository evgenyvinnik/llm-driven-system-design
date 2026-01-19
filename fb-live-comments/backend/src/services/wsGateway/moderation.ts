/**
 * Moderation Module
 *
 * Handles comment moderation, user validation, and ban checks
 * for the WebSocket gateway.
 *
 * @module services/wsGateway/moderation
 */

import { userService } from '../userService.js';
import { ExtendedWebSocket } from './types.js';
import { sendError } from './broadcast.js';
import { logger } from '../../shared/index.js';

const wsLogger = logger.child({ module: 'moderation' });

/**
 * Result of a ban check operation.
 */
export interface BanCheckResult {
  /** Whether the user is banned */
  isBanned: boolean;
  /** Reason for the ban, if applicable */
  reason?: string;
}

/**
 * Checks if a user is banned from a stream.
 *
 * @description Queries the user service to determine if a user has been banned
 * from participating in a specific stream. Implements a "fail open" policy -
 * if the ban check fails due to an error, the user is allowed to proceed.
 *
 * @param userId - The user ID to check
 * @param streamId - The stream ID to check against
 * @returns Promise resolving to a BanCheckResult with isBanned status
 *
 * @example
 * ```typescript
 * const { isBanned } = await checkUserBan('user-123', 'stream-456');
 * if (isBanned) {
 *   // Reject the user's action
 * }
 * ```
 */
export async function checkUserBan(userId: string, streamId: string): Promise<BanCheckResult> {
  try {
    const isBanned = await userService.isBanned(userId, streamId);
    return { isBanned };
  } catch (error) {
    wsLogger.error(
      { error: (error as Error).message, userId, streamId },
      'Error checking user ban status'
    );
    // Fail open - allow user if we can't check
    return { isBanned: false };
  }
}

/**
 * Validates that a user can post in a stream.
 *
 * @description Verifies that the WebSocket connection has an active stream session
 * and that the provided stream/user IDs match the session. This prevents users
 * from posting comments to streams they haven't joined or impersonating other users.
 *
 * @param ws - The WebSocket connection to validate
 * @param streamId - The expected stream ID from the request payload
 * @param userId - The expected user ID from the request payload
 * @returns True if validation passes, false if validation fails (error sent to client)
 *
 * @example
 * ```typescript
 * if (!validateUserSession(ws, payload.stream_id, payload.user_id)) {
 *   return; // Error already sent to client
 * }
 * // Proceed with the action
 * ```
 */
export function validateUserSession(
  ws: ExtendedWebSocket,
  streamId: string,
  userId: string
): boolean {
  if (!ws.streamId || !ws.userId) {
    sendError(ws, 'NOT_IN_STREAM', 'You must join a stream first');
    return false;
  }

  if (ws.streamId !== streamId || ws.userId !== userId) {
    sendError(ws, 'INVALID_REQUEST', 'Stream or user mismatch');
    return false;
  }

  return true;
}

/**
 * Rejects a connection if the user is banned.
 *
 * @description Combines ban checking with immediate rejection. If the user is banned,
 * sends an error message to the client and logs the attempt. This is the primary
 * entry point for ban enforcement during stream join operations.
 *
 * @param ws - The WebSocket connection attempting to join
 * @param userId - The user ID attempting to join
 * @param streamId - The stream ID the user is trying to join
 * @returns Promise resolving to true if user is banned (error already sent), false if allowed
 *
 * @example
 * ```typescript
 * if (await rejectIfBanned(ws, userId, streamId)) {
 *   return; // User is banned, error already sent
 * }
 * // User is allowed, proceed with join
 * ```
 */
export async function rejectIfBanned(
  ws: ExtendedWebSocket,
  userId: string,
  streamId: string
): Promise<boolean> {
  const { isBanned } = await checkUserBan(userId, streamId);

  if (isBanned) {
    sendError(ws, 'BANNED', 'You are banned from this stream');
    wsLogger.info({ userId, streamId }, 'Banned user attempted to join stream');
    return true;
  }

  return false;
}
