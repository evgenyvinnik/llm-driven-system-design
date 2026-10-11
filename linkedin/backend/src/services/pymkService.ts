/**
 * People You May Know: candidate generation, feature loading, caching and serving.
 *
 * 1. Candidates: second-degree members ranked by mutual count, capped at 100, already
 *    excluding current connections and anyone with a pending invitation either way.
 *    Members with too small a network get colleagues and classmates as well (cold start).
 * 2. Features: skills, companies, schools and location for the viewer and every
 *    candidate in four batched queries (the old loop issued four queries per
 *    candidate, one candidate at a time: ~400 sequential round trips).
 * 3. Scoring: pymkScoring.ts; the top 50 are cached for 24 hours.
 * 4. Serving: the cached list is filtered against the live first-degree set and
 *    pending invitations on every read, so someone you just connected with or
 *    invited disappears immediately even though the list itself is a day old.
 *
 * @module services/pymkService
 */
import { query } from '../utils/db.js';
import { redis } from '../utils/redis.js';
import { logger } from '../utils/logger.js';
import { cacheHitsTotal, cacheMissesTotal, pymkComputationDuration } from '../utils/metrics.js';
import { getFirstDegreeConnections, findSecondDegree } from './connectionService.js';
import { getUserSummaries } from './userService.js';
import {
  buildMemberFeatures,
  rankPymkCandidates,
  scorePymkCandidate,
  type MemberFeatureRows,
} from './pymkScoring.js';
import type { PYMKCandidate } from '../types/index.js';

const CACHE_TTL_SECONDS = 24 * 3600;
const CANDIDATE_LIMIT = 100;
const CACHED_RESULTS = 50;
/** Below this many graph candidates, add colleagues and classmates. */
const MIN_GRAPH_CANDIDATES = 10;

const cacheKey = (userId: number) => `pymk:${userId}`;

function networkSizeLabel(size: number): string {
  if (size < 100) return 'lt_100';
  if (size < 500) return '100_499';
  return 'gte_500';
}

async function pendingCounterparts(userId: number): Promise<number[]> {
  const rows = await query<{ other_id: number }>(
    `SELECT CASE WHEN from_user_id = $1 THEN to_user_id ELSE from_user_id END AS other_id
     FROM connection_requests
     WHERE status = 'pending' AND (from_user_id = $1 OR to_user_id = $1)`,
    [userId]
  );
  return rows.map((r) => r.other_id);
}

/** Colleagues (same company name) and classmates (same school), for thin networks. */
async function findAffinityCandidates(userId: number, exclude: number[], limit: number): Promise<number[]> {
  const rows = await query<{ user_id: number }>(
    `SELECT other_id AS user_id FROM (
       SELECT e2.user_id AS other_id
       FROM experiences e1
       JOIN experiences e2 ON LOWER(e2.company_name) = LOWER(e1.company_name)
       WHERE e1.user_id = $1
       UNION
       SELECT d2.user_id
       FROM education d1
       JOIN education d2 ON LOWER(d2.school_name) = LOWER(d1.school_name)
       WHERE d1.user_id = $1
     ) affinity
     WHERE other_id <> $1 AND other_id <> ALL($2::int[])
     ORDER BY other_id
     LIMIT $3`,
    [userId, exclude, limit]
  );
  return rows.map((r) => r.user_id);
}

/** Loads scoring features for many members in four queries. */
async function loadFeatureRows(ids: number[]): Promise<Map<number, MemberFeatureRows>> {
  const [users, experiences, education, skills] = await Promise.all([
    query<{ id: number; location: string | null }>(
      'SELECT id, location FROM users WHERE id = ANY($1::int[])',
      [ids]
    ),
    query<{ user_id: number; company_name: string; is_current: boolean }>(
      'SELECT user_id, company_name, is_current FROM experiences WHERE user_id = ANY($1::int[])',
      [ids]
    ),
    query<{ user_id: number; school_name: string }>(
      'SELECT user_id, school_name FROM education WHERE user_id = ANY($1::int[])',
      [ids]
    ),
    query<{ user_id: number; skill_id: number }>(
      'SELECT user_id, skill_id FROM user_skills WHERE user_id = ANY($1::int[])',
      [ids]
    ),
  ]);

  const rows = new Map<number, MemberFeatureRows>();
  for (const user of users) {
    rows.set(user.id, { experiences: [], education: [], skillIds: [], location: user.location });
  }
  for (const exp of experiences) rows.get(exp.user_id)?.experiences.push(exp);
  for (const edu of education) rows.get(edu.user_id)?.education.push(edu);
  for (const skill of skills) rows.get(skill.user_id)?.skillIds.push(skill.skill_id);
  return rows;
}

/**
 * Computes a fresh ranked suggestion list (no cache read, no serve-time filter).
 *
 * @param userId - The member receiving suggestions
 * @returns Up to 50 scored candidates, best first
 */
export async function computePeopleYouMayKnow(userId: number): Promise<PYMKCandidate[]> {
  const startedAt = Date.now();
  const [firstDegree, pending] = await Promise.all([
    getFirstDegreeConnections(userId),
    pendingCounterparts(userId),
  ]);

  const graphCandidates = await findSecondDegree(userId, firstDegree, {
    limit: CANDIDATE_LIMIT,
    excludePending: true,
  });
  const mutualCounts = new Map(graphCandidates.map((c) => [c.user_id, c.mutual_count ?? 0]));

  if (graphCandidates.length < MIN_GRAPH_CANDIDATES) {
    const exclude = [...firstDegree, ...pending, ...mutualCounts.keys()];
    const extra = await findAffinityCandidates(userId, exclude, CANDIDATE_LIMIT - graphCandidates.length);
    for (const id of extra) mutualCounts.set(id, 0);
  }
  if (mutualCounts.size === 0) return [];

  const candidateIds = [...mutualCounts.keys()];
  const [featureRows, summaries] = await Promise.all([
    loadFeatureRows([userId, ...candidateIds]),
    getUserSummaries(candidateIds),
  ]);

  const viewerRows = featureRows.get(userId);
  if (!viewerRows) return [];
  const viewer = buildMemberFeatures(viewerRows);

  const scored: PYMKCandidate[] = [];
  for (const summary of summaries) {
    const rows = featureRows.get(summary.id);
    if (!rows) continue;
    const mutual = mutualCounts.get(summary.id) ?? 0;
    const result = scorePymkCandidate(viewer, buildMemberFeatures(rows), mutual);
    scored.push({
      user: summary,
      score: result.score,
      mutual_connections: mutual,
      same_company: result.sameCompany,
      same_school: result.sameSchool,
      shared_skills: result.sharedSkills,
      same_location: result.sameLocation,
      reasons: result.reasons,
    });
  }

  const ranked = rankPymkCandidates(scored).slice(0, CACHED_RESULTS);
  pymkComputationDuration.observe(
    { user_network_size: networkSizeLabel(firstDegree.length) },
    (Date.now() - startedAt) / 1000
  );
  return ranked;
}

async function readCachedList(userId: number): Promise<PYMKCandidate[] | null> {
  try {
    const raw = await redis.get(cacheKey(userId));
    if (raw) {
      cacheHitsTotal.inc({ cache_name: 'pymk' });
      return JSON.parse(raw) as PYMKCandidate[];
    }
  } catch (error) {
    logger.warn({ error, userId }, 'PYMK cache unavailable');
  }
  cacheMissesTotal.inc({ cache_name: 'pymk' });
  return null;
}

/**
 * Returns suggestions for a member: the cached daily list, filtered against
 * connections and invitations made since it was computed.
 *
 * @param userId - The member receiving suggestions
 * @param limit - Maximum suggestions to return (default: 20)
 * @returns Suggestions with scores and reasons
 */
export async function getPeopleYouMayKnow(userId: number, limit = 20): Promise<PYMKCandidate[]> {
  let ranked = await readCachedList(userId);
  if (!ranked) {
    ranked = await computePeopleYouMayKnow(userId);
    redis
      .set(cacheKey(userId), JSON.stringify(ranked), 'EX', CACHE_TTL_SECONDS)
      .catch((error: unknown) => logger.warn({ error, userId }, 'Failed to cache PYMK'));
  }

  const [firstDegree, pending] = await Promise.all([
    getFirstDegreeConnections(userId),
    pendingCounterparts(userId),
  ]);
  const hidden = new Set([userId, ...firstDegree, ...pending]);
  return ranked.filter((candidate) => !hidden.has(candidate.user.id)).slice(0, limit);
}
