import { query, queryOne, execute } from '../utils/db.js';
import { cacheGet, cacheSet, cacheDel } from '../utils/redis.js';
import { getUserById, getUsersByIds, getUserSkills, getUserExperiences, getUserEducation } from './userService.js';
import type { User, ConnectionRequest, ConnectionDegree, PYMKCandidate } from '../types/index.js';

// Connection Management
export async function sendConnectionRequest(
  fromUserId: number,
  toUserId: number,
  message?: string
): Promise<ConnectionRequest> {
  // Check if already connected
  const connected = await areConnected(fromUserId, toUserId);
  if (connected) {
    throw new Error('Already connected');
  }

  // Check if request already exists
  const existing = await queryOne<ConnectionRequest>(
    `SELECT * FROM connection_requests
     WHERE (from_user_id = $1 AND to_user_id = $2) OR (from_user_id = $2 AND to_user_id = $1)`,
    [fromUserId, toUserId]
  );

  if (existing) {
    if (existing.status === 'pending') {
      throw new Error('Connection request already pending');
    }
    // Update existing request
    const updated = await queryOne<ConnectionRequest>(
      `UPDATE connection_requests SET from_user_id = $1, to_user_id = $2, message = $3, status = 'pending', updated_at = NOW()
       WHERE id = $4 RETURNING *`,
      [fromUserId, toUserId, message || null, existing.id]
    );
    return updated!;
  }

  const request = await queryOne<ConnectionRequest>(
    `INSERT INTO connection_requests (from_user_id, to_user_id, message)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [fromUserId, toUserId, message || null]
  );
  return request!;
}

export async function acceptConnectionRequest(requestId: number, userId: number): Promise<void> {
  const request = await queryOne<ConnectionRequest>(
    `SELECT * FROM connection_requests WHERE id = $1 AND to_user_id = $2 AND status = 'pending'`,
    [requestId, userId]
  );

  if (!request) {
    throw new Error('Connection request not found');
  }

  // Create connection (always store with smaller id first)
  const [smallerId, largerId] = request.from_user_id < request.to_user_id
    ? [request.from_user_id, request.to_user_id]
    : [request.to_user_id, request.from_user_id];

  await execute(
    `INSERT INTO connections (user_id, connected_to) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [smallerId, largerId]
  );

  // Update request status
  await execute(
    `UPDATE connection_requests SET status = 'accepted', updated_at = NOW() WHERE id = $1`,
    [requestId]
  );

  // Update connection counts
  await execute(
    `UPDATE users SET connection_count = connection_count + 1 WHERE id IN ($1, $2)`,
    [request.from_user_id, request.to_user_id]
  );

  // Invalidate caches
  await cacheDel(`connections:${request.from_user_id}`);
  await cacheDel(`connections:${request.to_user_id}`);
  await cacheDel(`pymk:${request.from_user_id}`);
  await cacheDel(`pymk:${request.to_user_id}`);
}

export async function rejectConnectionRequest(requestId: number, userId: number): Promise<void> {
  await execute(
    `UPDATE connection_requests SET status = 'rejected', updated_at = NOW()
     WHERE id = $1 AND to_user_id = $2`,
    [requestId, userId]
  );
}

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

export async function removeConnection(userId: number, connectedUserId: number): Promise<void> {
  const [smallerId, largerId] = userId < connectedUserId
    ? [userId, connectedUserId]
    : [connectedUserId, userId];

  const count = await execute(
    `DELETE FROM connections WHERE user_id = $1 AND connected_to = $2`,
    [smallerId, largerId]
  );

  if (count > 0) {
    await execute(
      `UPDATE users SET connection_count = GREATEST(0, connection_count - 1) WHERE id IN ($1, $2)`,
      [userId, connectedUserId]
    );
    await cacheDel(`connections:${userId}`);
    await cacheDel(`connections:${connectedUserId}`);
  }
}

export async function areConnected(userId1: number, userId2: number): Promise<boolean> {
  const [smallerId, largerId] = userId1 < userId2 ? [userId1, userId2] : [userId2, userId1];
  const result = await queryOne<{ exists: boolean }>(
    `SELECT EXISTS(SELECT 1 FROM connections WHERE user_id = $1 AND connected_to = $2) as exists`,
    [smallerId, largerId]
  );
  return result?.exists || false;
}

// Get first-degree connections
export async function getFirstDegreeConnections(userId: number): Promise<number[]> {
  const cacheKey = `connections:${userId}`;
  const cached = await cacheGet<number[]>(cacheKey);
  if (cached) return cached;

  const connections = await query<{ connected_user_id: number }>(
    `SELECT CASE WHEN user_id = $1 THEN connected_to ELSE user_id END as connected_user_id
     FROM connections
     WHERE user_id = $1 OR connected_to = $1`,
    [userId]
  );

  const ids = connections.map(c => c.connected_user_id);
  await cacheSet(cacheKey, ids, 3600); // Cache for 1 hour
  return ids;
}

// Get second-degree connections
export async function getSecondDegreeConnections(userId: number): Promise<ConnectionDegree[]> {
  const firstDegree = await getFirstDegreeConnections(userId);
  if (firstDegree.length === 0) return [];

  const firstDegreeSet = new Set(firstDegree);

  const placeholders = firstDegree.map((_, i) => `$${i + 2}`).join(',');

  const secondDegree = await query<{ user_id: number; mutual_count: number }>(
    `SELECT
       CASE WHEN user_id = ANY($1::int[]) THEN connected_to ELSE user_id END as user_id,
       COUNT(*) as mutual_count
     FROM connections
     WHERE (user_id = ANY($1::int[]) OR connected_to = ANY($1::int[]))
       AND NOT (user_id = $2 OR connected_to = $2)
     GROUP BY 1
     HAVING CASE WHEN user_id = ANY($1::int[]) THEN connected_to ELSE user_id END != $2`,
    [firstDegree, userId]
  );

  return secondDegree
    .filter(s => !firstDegreeSet.has(s.user_id) && s.user_id !== userId)
    .map(s => ({
      user_id: s.user_id,
      degree: 2,
      mutual_count: Number(s.mutual_count),
    }));
}

// Get mutual connections between two users
export async function getMutualConnections(userId1: number, userId2: number): Promise<number[]> {
  const [conn1, conn2] = await Promise.all([
    getFirstDegreeConnections(userId1),
    getFirstDegreeConnections(userId2),
  ]);

  const set1 = new Set(conn1);
  return conn2.filter(id => set1.has(id));
}

// Get connection degree between two users
export async function getConnectionDegree(userId1: number, userId2: number): Promise<number | null> {
  if (userId1 === userId2) return 0;

  // Check 1st degree
  const connected = await areConnected(userId1, userId2);
  if (connected) return 1;

  // Check 2nd degree
  const firstDegree = await getFirstDegreeConnections(userId1);
  const secondDegree = await getFirstDegreeConnections(userId2);

  const hasCommon = firstDegree.some(id => secondDegree.includes(id));
  if (hasCommon) return 2;

  // Check 3rd degree (simplified - could be optimized with precomputation)
  const secondDegreeIds = await getSecondDegreeConnections(userId1);
  const secondDegreeSet = new Set(secondDegreeIds.map(s => s.user_id));

  if (secondDegreeSet.has(userId2)) return 2;

  const hasThirdDegree = secondDegree.some(id => secondDegreeSet.has(id));
  if (hasThirdDegree) return 3;

  return null; // Not connected within 3 degrees
}

// People You May Know (PYMK)
export async function getPeopleYouMayKnow(userId: number, limit = 20): Promise<PYMKCandidate[]> {
  const cacheKey = `pymk:${userId}`;
  const cached = await cacheGet<PYMKCandidate[]>(cacheKey);
  if (cached) return cached.slice(0, limit);

  const user = await getUserById(userId);
  if (!user) return [];

  const firstDegree = await getFirstDegreeConnections(userId);
  const firstDegreeSet = new Set(firstDegree);

  const secondDegree = await getSecondDegreeConnections(userId);

  // Get user's skills and experiences for matching
  const [userSkills, userExperiences, userEducation] = await Promise.all([
    getUserSkills(userId),
    getUserExperiences(userId),
    getUserEducation(userId),
  ]);

  const userSkillIds = new Set(userSkills.map(s => s.skill_id));
  const userCompanies = new Set(userExperiences.map(e => e.company_name.toLowerCase()));
  const userSchools = new Set(userEducation.map(e => e.school_name.toLowerCase()));

  // Score candidates
  const candidates: PYMKCandidate[] = [];

  for (const candidate of secondDegree.slice(0, 100)) { // Limit for performance
    const candidateUser = await getUserById(candidate.user_id);
    if (!candidateUser) continue;

    const [candSkills, candExp, candEdu] = await Promise.all([
      getUserSkills(candidate.user_id),
      getUserExperiences(candidate.user_id),
      getUserEducation(candidate.user_id),
    ]);

    // Calculate PYMK score
    let score = 0;

    // Mutual connections (strongest signal)
    const mutualCount = candidate.mutual_count || 0;
    score += mutualCount * 10;

    // Same company (current or past)
    const sameCompany = candExp.some(e => userCompanies.has(e.company_name.toLowerCase()));
    if (sameCompany) score += 8;

    // Same school
    const sameSchool = candEdu.some(e => userSchools.has(e.school_name.toLowerCase()));
    if (sameSchool) score += 5;

    // Shared skills
    const sharedSkills = candSkills.filter(s => userSkillIds.has(s.skill_id)).length;
    score += sharedSkills * 2;

    // Same location
    const sameLocation = candidateUser.location && user.location &&
      candidateUser.location.toLowerCase() === user.location.toLowerCase();
    if (sameLocation) score += 2;

    candidates.push({
      user: candidateUser,
      score,
      mutual_connections: mutualCount,
      same_company: sameCompany,
      same_school: sameSchool,
      shared_skills: sharedSkills,
      same_location: !!sameLocation,
    });
  }

  // Sort by score descending
  candidates.sort((a, b) => b.score - a.score);
  const topCandidates = candidates.slice(0, 50);

  await cacheSet(cacheKey, topCandidates, 3600 * 24); // Cache for 24 hours
  return topCandidates.slice(0, limit);
}

// Get connections with user data
export async function getConnectionsWithData(
  userId: number,
  offset = 0,
  limit = 20
): Promise<User[]> {
  const connectionIds = await getFirstDegreeConnections(userId);
  const paginatedIds = connectionIds.slice(offset, offset + limit);
  return getUsersByIds(paginatedIds);
}
