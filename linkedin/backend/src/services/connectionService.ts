import type { PoolClient } from 'pg';
import { query, queryOne, withTransaction } from '../utils/db.js';
import { cacheDel } from '../utils/redis.js';
import { getCachedFirstDegree, bumpGraphVersion } from '../utils/graphCache.js';
import { ApiError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { getUsersByIds, getUserSummaries } from './userService.js';
import { findConnectionPath } from './connectionPath.js';
import type { User, ConnectionRequest, ConnectionDegree, Relationship } from '../types/index.js';

/**
 * What sending an invitation actually did:
 * - sent: a new (or re-opened) pending invitation
 * - already_pending: the same invitation was already waiting (a retry or double click)
 * - accepted_reverse: the other person had already invited us, so we accepted theirs
 */
export type SendOutcome = 'sent' | 'already_pending' | 'accepted_reverse';

/** Every undirected edge is stored once, smaller id first (CHECK user_id < connected_to). */
function orderedPair(a: number, b: number): [number, number] {
  return a < b ? [a, b] : [b, a];
}

/**
 * Serializes every lifecycle operation on one pair of members, in both directions,
 * for the rest of the transaction. Without it, A inviting B while B invites A both
 * see "no invitation from the other side" and create two crossing invitations.
 */
async function lockPair(client: PoolClient, a: number, b: number): Promise<void> {
  const [low, high] = orderedPair(a, b);
  await client.query('SELECT pg_advisory_xact_lock($1, $2)', [low, high]);
}

async function edgeExists(client: PoolClient, a: number, b: number): Promise<boolean> {
  const [low, high] = orderedPair(a, b);
  const result = await client.query(
    'SELECT 1 FROM connections WHERE user_id = $1 AND connected_to = $2',
    [low, high]
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Runs after a graph write commits: new cache versions for both members' lists and
 * their PYMK lists dropped so the next read recomputes (PYMK is also filtered at
 * serve time, so a failed delete only costs freshness).
 */
async function afterGraphChange(userIds: number[]): Promise<void> {
  await bumpGraphVersion(userIds);
  await Promise.all(
    userIds.map((id) =>
      cacheDel(`pymk:${id}`).catch((error: unknown) =>
        logger.warn({ error, userId: id }, 'Failed to drop PYMK cache')
      )
    )
  );
}

/**
 * Accepts a pending invitation. Caller must hold the pair lock.
 * The conditional UPDATE is the claim: of two concurrent accepts only one sees
 * status = 'pending', so the edge and both counters change exactly once.
 */
async function acceptLocked(
  client: PoolClient,
  requestId: number,
  recipientId: number
): Promise<{ request: ConnectionRequest; changed: boolean }> {
  const claimed = await client.query<ConnectionRequest>(
    `UPDATE connection_requests SET status = 'accepted', updated_at = NOW()
     WHERE id = $1 AND to_user_id = $2 AND status = 'pending'
     RETURNING *`,
    [requestId, recipientId]
  );
  const request = claimed.rows[0];

  if (!request) {
    const current = await client.query<ConnectionRequest>(
      'SELECT * FROM connection_requests WHERE id = $1 AND to_user_id = $2',
      [requestId, recipientId]
    );
    const existing = current.rows[0];
    if (!existing) throw new ApiError(404, 'request_not_found', 'Connection request not found');
    // A retried accept (double click, timeout + retry) is a success, not an error.
    if (existing.status === 'accepted' && (await edgeExists(client, existing.from_user_id, existing.to_user_id))) {
      return { request: existing, changed: false };
    }
    throw new ApiError(409, 'request_not_pending', 'Connection request is no longer pending');
  }

  const [low, high] = orderedPair(request.from_user_id, request.to_user_id);
  const edge = await client.query(
    'INSERT INTO connections (user_id, connected_to) VALUES ($1, $2) ON CONFLICT DO NOTHING',
    [low, high]
  );
  const created = (edge.rowCount ?? 0) > 0;
  if (created) {
    // Counters move only with the edge they describe, inside the same transaction.
    await client.query(
      'UPDATE users SET connection_count = connection_count + 1 WHERE id IN ($1, $2)',
      [low, high]
    );
  }
  // An invitation in the opposite direction is now moot.
  await client.query(
    `UPDATE connection_requests SET status = 'accepted', updated_at = NOW()
     WHERE from_user_id = $1 AND to_user_id = $2 AND status = 'pending'`,
    [request.to_user_id, request.from_user_id]
  );
  return { request, changed: created };
}

/**
 * Sends a connection invitation.
 * One transaction under a per-pair lock: rejects self and existing connections,
 * accepts a crossing invitation instead of creating a second one, and treats a
 * repeated send as a no-op that returns the waiting invitation.
 *
 * @param fromUserId - The member sending the invitation
 * @param toUserId - The member being invited
 * @param message - Optional personal note
 * @returns The outcome and the invitation it refers to
 * @throws ApiError 400 self, 404 unknown member, 409 already connected
 */
export async function sendConnectionRequest(
  fromUserId: number,
  toUserId: number,
  message?: string
): Promise<{ outcome: SendOutcome; request: ConnectionRequest }> {
  if (fromUserId === toUserId) {
    throw new ApiError(400, 'self_connection', 'Cannot connect with yourself');
  }

  const result = await withTransaction(async (client) => {
    await lockPair(client, fromUserId, toUserId);

    const target = await client.query('SELECT 1 FROM users WHERE id = $1', [toUserId]);
    if (!target.rowCount) throw new ApiError(404, 'user_not_found', 'User not found');

    if (await edgeExists(client, fromUserId, toUserId)) {
      throw new ApiError(409, 'already_connected', 'Already connected');
    }

    // Mutual intent: they already invited us, so connect now.
    const reverse = await client.query<ConnectionRequest>(
      `SELECT id FROM connection_requests
       WHERE from_user_id = $1 AND to_user_id = $2 AND status = 'pending'`,
      [toUserId, fromUserId]
    );
    if (reverse.rows[0]) {
      const accepted = await acceptLocked(client, reverse.rows[0].id, fromUserId);
      return { outcome: 'accepted_reverse' as const, request: accepted.request };
    }

    // Insert, or re-open a declined/withdrawn invitation; a pending one is left alone.
    const upsert = await client.query<ConnectionRequest>(
      `INSERT INTO connection_requests (from_user_id, to_user_id, message)
       VALUES ($1, $2, $3)
       ON CONFLICT (from_user_id, to_user_id) DO UPDATE
         SET status = 'pending', message = EXCLUDED.message,
             created_at = NOW(), updated_at = NOW()
         WHERE connection_requests.status <> 'pending'
       RETURNING *`,
      [fromUserId, toUserId, message || null]
    );
    if (upsert.rows[0]) return { outcome: 'sent' as const, request: upsert.rows[0] };

    const existing = await client.query<ConnectionRequest>(
      'SELECT * FROM connection_requests WHERE from_user_id = $1 AND to_user_id = $2',
      [fromUserId, toUserId]
    );
    return { outcome: 'already_pending' as const, request: existing.rows[0] };
  });

  if (result.outcome === 'accepted_reverse') {
    await afterGraphChange([fromUserId, toUserId]);
  }
  return result;
}

/**
 * Accepts a pending connection request and creates the connection.
 * Idempotent: accepting an already-accepted request returns it with changed=false.
 *
 * @param requestId - The connection request ID
 * @param userId - The user accepting (must be the request recipient)
 * @returns The request and whether a new connection was created
 * @throws ApiError 404 not found, 409 declined or withdrawn
 */
export async function acceptConnectionRequest(
  requestId: number,
  userId: number
): Promise<{ request: ConnectionRequest; changed: boolean }> {
  const outcome = await withTransaction(async (client) => {
    const found = await client.query<ConnectionRequest>(
      'SELECT from_user_id, to_user_id FROM connection_requests WHERE id = $1 AND to_user_id = $2',
      [requestId, userId]
    );
    const pair = found.rows[0];
    if (!pair) throw new ApiError(404, 'request_not_found', 'Connection request not found');
    await lockPair(client, pair.from_user_id, pair.to_user_id);
    return acceptLocked(client, requestId, userId);
  });

  if (outcome.changed) {
    await afterGraphChange([outcome.request.from_user_id, outcome.request.to_user_id]);
  }
  return outcome;
}

/**
 * Declines a pending connection request. Idempotent for an already-declined request.
 *
 * @param requestId - The connection request ID
 * @param userId - The user rejecting (must be the request recipient)
 * @returns The request and whether its status changed
 */
export async function rejectConnectionRequest(
  requestId: number,
  userId: number
): Promise<{ request: ConnectionRequest; changed: boolean }> {
  return closeRequest(requestId, 'to_user_id', userId, 'rejected');
}

/**
 * Withdraws an invitation the caller sent. Idempotent for an already-withdrawn one.
 *
 * @param requestId - The connection request ID
 * @param userId - The user withdrawing (must be the sender)
 * @returns The request and whether its status changed
 */
export async function withdrawConnectionRequest(
  requestId: number,
  userId: number
): Promise<{ request: ConnectionRequest; changed: boolean }> {
  return closeRequest(requestId, 'from_user_id', userId, 'withdrawn');
}

async function closeRequest(
  requestId: number,
  party: 'from_user_id' | 'to_user_id',
  userId: number,
  status: 'rejected' | 'withdrawn'
): Promise<{ request: ConnectionRequest; changed: boolean }> {
  const updated = await queryOne<ConnectionRequest>(
    `UPDATE connection_requests SET status = $3, updated_at = NOW()
     WHERE id = $1 AND ${party} = $2 AND status = 'pending'
     RETURNING *`,
    [requestId, userId, status]
  );
  if (updated) return { request: updated, changed: true };

  const existing = await queryOne<ConnectionRequest>(
    `SELECT * FROM connection_requests WHERE id = $1 AND ${party} = $2`,
    [requestId, userId]
  );
  if (!existing) throw new ApiError(404, 'request_not_found', 'Connection request not found');
  if (existing.status === status) return { request: existing, changed: false };
  throw new ApiError(409, 'request_not_pending', 'Connection request is no longer pending');
}

/**
 * Retrieves pending connection requests for a user.
 * Includes sender information for display in the UI.
 *
 * @param userId - The user's ID receiving the requests
 * @returns Array of pending requests with sender details
 */
export async function getPendingRequests(userId: number): Promise<(ConnectionRequest & { from_user: User })[]> {
  const requests = await query<ConnectionRequest & { from_user: User }>(
    `SELECT cr.*,
            json_build_object(
              'id', u.id,
              'first_name', u.first_name,
              'last_name', u.last_name,
              'headline', u.headline,
              'profile_image_url', u.profile_image_url
            ) as from_user
     FROM connection_requests cr
     JOIN users u ON cr.from_user_id = u.id
     WHERE cr.to_user_id = $1 AND cr.status = 'pending'
     ORDER BY cr.created_at DESC`,
    [userId]
  );
  return requests;
}

/**
 * Removes an existing connection between two users.
 * The edge delete and both counter decrements commit together.
 *
 * @param userId - The user initiating the removal
 * @param connectedUserId - The connected user to remove
 * @returns True if a connection existed and was removed
 */
export async function removeConnection(userId: number, connectedUserId: number): Promise<boolean> {
  const removed = await withTransaction(async (client) => {
    await lockPair(client, userId, connectedUserId);
    const [low, high] = orderedPair(userId, connectedUserId);
    const deleted = await client.query(
      'DELETE FROM connections WHERE user_id = $1 AND connected_to = $2',
      [low, high]
    );
    if (!deleted.rowCount) return false;
    await client.query(
      'UPDATE users SET connection_count = GREATEST(0, connection_count - 1) WHERE id IN ($1, $2)',
      [low, high]
    );
    return true;
  });

  if (removed) await afterGraphChange([userId, connectedUserId]);
  return removed;
}

/**
 * Checks if two users are directly connected (1st degree).
 *
 * @param userId1 - First user's ID
 * @param userId2 - Second user's ID
 * @returns True if users are connected, false otherwise
 */
export async function areConnected(userId1: number, userId2: number): Promise<boolean> {
  const [smallerId, largerId] = orderedPair(userId1, userId2);
  const result = await queryOne<{ exists: boolean }>(
    `SELECT EXISTS(SELECT 1 FROM connections WHERE user_id = $1 AND connected_to = $2) as exists`,
    [smallerId, largerId]
  );
  return result?.exists || false;
}

/**
 * Loads a user's connection ids, most recent first. Two index scans (the primary
 * key covers user_id, idx_connections_connected_to covers the other side) instead
 * of one OR that can only use one index.
 */
async function loadFirstDegree(userId: number): Promise<number[]> {
  const rows = await query<{ id: number }>(
    `SELECT id FROM (
       SELECT connected_to AS id, connected_at FROM connections WHERE user_id = $1
       UNION ALL
       SELECT user_id AS id, connected_at FROM connections WHERE connected_to = $1
     ) c
     ORDER BY connected_at DESC, id`,
    [userId]
  );
  return rows.map((r) => r.id);
}

/**
 * Retrieves all first-degree connection IDs for a user, most recent first.
 * Served from the versioned graph cache (see utils/graphCache).
 *
 * @param userId - The user's unique identifier
 * @returns Array of connected user IDs
 */
export async function getFirstDegreeConnections(userId: number): Promise<number[]> {
  return getCachedFirstDegree(userId, () => loadFirstDegree(userId));
}

/**
 * Enumerates second-degree members (friends of friends) with their mutual counts,
 * strongest first. This is PYMK's candidate generator; capped because a member with
 * 500 connections has on the order of 250K second-degree members.
 *
 * @param userId - The member at the center
 * @param firstDegree - The member's first-degree ids
 * @param options.limit - Maximum candidates
 * @param options.excludePending - Skip anyone with a pending invitation either way
 * @returns Candidates ordered by mutual count descending
 */
export async function findSecondDegree(
  userId: number,
  firstDegree: number[],
  options: { limit: number; excludePending: boolean }
): Promise<ConnectionDegree[]> {
  if (firstDegree.length === 0) return [];
  const rows = await query<{ user_id: number; mutual_count: number }>(
    `WITH reach AS (
       SELECT connected_to AS candidate, user_id AS via
       FROM connections WHERE user_id = ANY($1::int[])
       UNION ALL
       SELECT user_id AS candidate, connected_to AS via
       FROM connections WHERE connected_to = ANY($1::int[])
     )
     SELECT candidate AS user_id, COUNT(DISTINCT via)::int AS mutual_count
     FROM reach
     WHERE candidate <> $2
       AND candidate <> ALL($1::int[])
       AND (NOT $4 OR NOT EXISTS (
         SELECT 1 FROM connection_requests r
         WHERE r.status = 'pending'
           AND ((r.from_user_id = $2 AND r.to_user_id = reach.candidate)
             OR (r.from_user_id = reach.candidate AND r.to_user_id = $2))))
     GROUP BY candidate
     ORDER BY mutual_count DESC, candidate
     LIMIT $3`,
    [firstDegree, userId, options.limit, options.excludePending]
  );
  return rows.map((r) => ({ user_id: r.user_id, degree: 2, mutual_count: Number(r.mutual_count) }));
}

/**
 * Retrieves second-degree connections (friends of friends), strongest first.
 *
 * @param userId - The user's unique identifier
 * @param limit - Maximum results (default: 50)
 * @returns Array of second-degree connections with mutual counts
 */
export async function getSecondDegreeConnections(userId: number, limit = 50): Promise<ConnectionDegree[]> {
  const firstDegree = await getFirstDegreeConnections(userId);
  return findSecondDegree(userId, firstDegree, { limit, excludePending: false });
}

/**
 * Finds mutual connections between two users.
 * Useful for showing common connections on profiles.
 *
 * @param userId1 - First user's ID
 * @param userId2 - Second user's ID
 * @returns Array of user IDs connected to both users
 */
export async function getMutualConnections(userId1: number, userId2: number): Promise<number[]> {
  const [conn1, conn2] = await Promise.all([
    getFirstDegreeConnections(userId1),
    getFirstDegreeConnections(userId2),
  ]);

  const set1 = new Set(conn1);
  return conn2.filter(id => set1.has(id));
}

/**
 * One indexed probe for an edge joining the two first-degree sets (the meeting point
 * of the bidirectional search). Returns it oriented [viewer side, target side].
 */
async function findBridge(viewerFirst: number[], targetFirst: number[]): Promise<[number, number] | null> {
  const row = await queryOne<{ user_id: number; connected_to: number }>(
    `SELECT user_id, connected_to FROM connections
     WHERE (user_id = ANY($1::int[]) AND connected_to = ANY($2::int[]))
        OR (user_id = ANY($2::int[]) AND connected_to = ANY($1::int[]))
     LIMIT 1`,
    [viewerFirst, targetFirst]
  );
  if (!row) return null;
  return viewerFirst.includes(row.user_id)
    ? [row.user_id, row.connected_to]
    : [row.connected_to, row.user_id];
}

/**
 * Describes how the viewer relates to another member: degree (1st to 3rd), the
 * invitation state that decides which button to show, mutual count, and one
 * shortest "how you're connected" path.
 *
 * @param viewerId - The member looking at the profile
 * @param targetId - The member being looked at
 * @returns The relationship
 * @throws ApiError 404 when the target does not exist
 */
export async function getRelationship(viewerId: number, targetId: number): Promise<Relationship> {
  if (viewerId === targetId) {
    return { degree: 0, status: 'self', request_id: null, mutual_count: 0, path: [] };
  }

  const [target, viewerFirst, targetFirst, pending] = await Promise.all([
    queryOne<{ id: number }>('SELECT id FROM users WHERE id = $1', [targetId]),
    getFirstDegreeConnections(viewerId),
    getFirstDegreeConnections(targetId),
    queryOne<{ id: number; from_user_id: number }>(
      `SELECT id, from_user_id FROM connection_requests
       WHERE status = 'pending'
         AND ((from_user_id = $1 AND to_user_id = $2) OR (from_user_id = $2 AND to_user_id = $1))
       ORDER BY created_at DESC LIMIT 1`,
      [viewerId, targetId]
    ),
  ]);
  if (!target) throw new ApiError(404, 'user_not_found', 'User not found');

  const result = await findConnectionPath(viewerId, targetId, viewerFirst, targetFirst, findBridge);
  const status: Relationship['status'] =
    result.degree === 1
      ? 'connected'
      : pending
        ? pending.from_user_id === viewerId
          ? 'pending_sent'
          : 'pending_received'
        : 'none';

  return {
    degree: result.degree,
    status,
    request_id: status === 'pending_sent' || status === 'pending_received' ? pending!.id : null,
    mutual_count: result.mutualIds.length,
    path: await getUserSummaries(result.pathIds),
  };
}

/**
 * Retrieves connections with public profile data, most recently connected first.
 *
 * @param userId - The user's unique identifier
 * @param offset - Number of connections to skip (default: 0)
 * @param limit - Maximum connections to return (default: 20)
 * @returns Array of user objects for the connection list
 */
export async function getConnectionsWithData(
  userId: number,
  offset = 0,
  limit = 20
): Promise<User[]> {
  const connectionIds = await getFirstDegreeConnections(userId);
  const paginatedIds = connectionIds.slice(offset, offset + limit);
  return getUsersByIds(paginatedIds);
}
