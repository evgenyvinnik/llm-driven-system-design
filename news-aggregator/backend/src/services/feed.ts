/**
 * Feed service for generating personalized news feeds.
 * Implements multi-signal ranking combining relevance, freshness, quality, and trending.
 * Provides feeds for personalized content, topic filtering, breaking news, and trending stories.
 *
 * Features:
 * - Redis caching with configurable TTL
 * - Cache metrics for observability
 * - Efficient cache invalidation
 * @module services/feed
 */

import { v4 as uuid } from 'uuid';
import { query, queryOne } from '../db/postgres.js';

// Shared modules
import { logger } from '../shared/logger.js';
import { config } from '../shared/config.js';
import {
  getOrSet,
  CacheKeys,
  CacheTTL,
  getFromCache,
  setInCache,
} from '../shared/cache.js';
import {
  feedGenerationsTotal,
  feedGenerationDuration,
} from '../shared/metrics.js';

/** Represents a clustered news story with multiple article sources */
interface Story {
  id: string;
  title: string;
  summary: string;
  primary_topic: string;
  topics: string[];
  article_count: number;
  source_count: number;
  velocity: number;
  is_breaking: boolean;
  created_at: Date;
  updated_at: Date;
  /** Arrival time of the newest article; drives velocity decay */
  last_article_at?: Date | null;
  /** Distinct sources covering the story (candidate queries only) */
  source_ids?: string[];
  articles?: ArticleSummary[];
}

/** Brief article information for story listings */
interface ArticleSummary {
  id: string;
  source_id: string;
  source_name: string;
  title: string;
  summary: string;
  url: string;
  published_at: Date;
}

/** User profile data for personalization */
interface UserProfile {
  user_id: string;
  topic_weights: Map<string, number>;
  preferred_sources: string[];
  blocked_sources: string[];
}

/** Story with computed ranking score */
interface FeedItem extends Story {
  score: number;
}

/** Paginated feed response */
interface FeedResponse {
  stories: FeedItem[];
  next_cursor: string | null;
  has_more: boolean;
}

/**
 * A ranked feed frozen in Redis: story ids in rank order with their scores.
 * Page 1 creates it; every later page of the same scroll reads from it, so
 * pages never overlap or skip stories while the live ranking keeps moving.
 */
export interface FeedSnapshot {
  /** user id, or 'anon'; a snapshot is only served to its owner */
  owner: string;
  ids: string[];
  scores: number[];
}

/** Opaque cursor payload: which snapshot, and the offset into it. */
export interface FeedCursor {
  s: string;
  o: number;
}

/** Candidate pool size for ranking (stories from the matching window). */
const CANDIDATE_LIMIT = 200;

/** Relevance bonus when a story is covered by one of the user's preferred sources. */
const PREFERRED_SOURCE_BOOST = 0.2;

/**
 * Encode a feed cursor as an opaque base64url token.
 * @param cursor - Snapshot id and offset
 * @returns Cursor string for the client
 */
export function encodeCursor(cursor: FeedCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

/**
 * Decode a cursor produced by encodeCursor. Anything else (including the old
 * numeric offsets) decodes to null, which means "start from the top".
 * @param raw - Cursor from the query string
 * @returns Parsed cursor, or null
 */
export function decodeCursor(raw: string | null | undefined): FeedCursor | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (typeof value?.s === 'string' && Number.isInteger(value?.o) && value.o >= 0) {
      return { s: value.s, o: value.o };
    }
  } catch {
    // fall through
  }
  return null;
}

/**
 * Get personalized feed for a user, one page at a time.
 *
 * The first page ranks up to 200 candidate stories once and freezes the order
 * in a Redis snapshot (TTL CACHE_FEED_SNAPSHOT_TTL); the cursor names the
 * snapshot and an offset, so later pages continue the same ordering instead of
 * re-ranking a list that has shifted in the meantime. A viewer's newest
 * snapshot is reused for page 1 for CACHE_FEED_TTL seconds, which is the feed
 * cache. Story details are hydrated per page, so counts stay current.
 * @param userId - User ID for personalization (null for anonymous)
 * @param cursor - Cursor from the previous response
 * @param limit - Number of stories to return (default: 20)
 * @returns Paginated feed response with scored stories
 */
export async function getPersonalizedFeed(
  userId: string | null,
  cursor: string | null = null,
  limit: number = 20
): Promise<FeedResponse> {
  const startTime = process.hrtime.bigint();
  const feedType = userId ? 'personalized' : 'anonymous';
  const owner = userId ?? 'anon';
  const parsed = decodeCursor(cursor);

  try {
    const profile = userId ? await getUserProfile(userId) : null;

    let snapshotId = parsed?.s ?? (await getFromCache<string>(CacheKeys.currentFeed(owner), 'feed'));
    let snapshot = snapshotId
      ? await getFromCache<FeedSnapshot>(CacheKeys.feedSnapshot(snapshotId), 'feed_snapshot')
      : null;
    if (snapshot && snapshot.owner !== owner) {
      snapshot = null; // someone else's cursor: never reveal another user's ranking
    }

    const cached = snapshot !== null;
    if (!snapshot) {
      // Expired snapshot mid-scroll: rank again and continue at the same
      // offset. The client drops any story it already shows.
      snapshot = await computeFeedSnapshot(owner, profile);
      snapshotId = uuid();
      await setInCache(CacheKeys.feedSnapshot(snapshotId), snapshot, config.cache.feedSnapshotTtl);
      await setInCache(CacheKeys.currentFeed(owner), snapshotId, config.cache.feedTtl);
    }

    const offset = parsed?.o ?? 0;
    const pageIds = snapshot.ids.slice(offset, offset + limit);
    const scores = new Map(snapshot.ids.map((id, i) => [id, snapshot.scores[i]]));
    const stories = await hydrateStories(pageIds, profile?.blocked_sources ?? [], scores);
    const hasMore = offset + limit < snapshot.ids.length;

    const durationSec = Number(process.hrtime.bigint() - startTime) / 1e9;
    feedGenerationDuration.observe({ type: feedType, cached: String(cached) }, durationSec);
    feedGenerationsTotal.inc({ type: feedType, cached: String(cached) });

    return {
      stories,
      next_cursor: hasMore ? encodeCursor({ s: snapshotId as string, o: offset + limit }) : null,
      has_more: hasMore,
    };
  } catch (error) {
    logger.error({ userId, cursor, limit, error }, 'Failed to get personalized feed');
    throw error;
  }
}

/**
 * Rank the candidate pool for one viewer (called when no snapshot is fresh).
 * @param owner - User id or 'anon'
 * @param profile - Personalization profile, or null for anonymous
 * @returns Snapshot of story ids in rank order
 */
async function computeFeedSnapshot(owner: string, profile: UserProfile | null): Promise<FeedSnapshot> {
  const candidates = await getCandidateStories(CANDIDATE_LIMIT);
  const ranked = rankStories(candidates, profile, Date.now());
  return {
    owner,
    ids: ranked.map(story => story.id),
    scores: ranked.map(story => Math.round(story.score * 10000) / 10000),
  };
}

/**
 * Score, sort and diversify candidates. Stories covered only by sources the
 * user blocked are dropped entirely.
 * @param candidates - Candidate stories (with source_ids)
 * @param profile - Personalization profile, or null for anonymous
 * @param nowMs - Current time, injectable for tests
 * @returns Ranked stories with final scores
 */
export function rankStories(candidates: Story[], profile: UserProfile | null, nowMs: number): FeedItem[] {
  const blocked = new Set(profile?.blocked_sources ?? []);
  const visible = candidates.filter(story => {
    const sources = story.source_ids ?? [];
    return blocked.size === 0 || sources.length === 0 || sources.some(id => !blocked.has(id));
  });

  const scored = visible.map(story => ({
    ...story,
    score: calculateStoryScore(story, profile, nowMs),
  }));
  scored.sort((a, b) => b.score - a.score);
  return applyDiversityPenalty(scored);
}

/**
 * Load story rows and their newest articles for one page, preserving the
 * snapshot order. Articles from blocked sources are left out of the preview.
 * Two queries per page regardless of page size (no per-story round trips).
 * @param ids - Story ids in rank order
 * @param blockedSources - Source ids hidden for this viewer
 * @param scores - Snapshot scores by story id
 * @returns Feed items in the given order (stories deleted since are skipped)
 */
async function hydrateStories(
  ids: string[],
  blockedSources: string[],
  scores: Map<string, number>
): Promise<FeedItem[]> {
  if (ids.length === 0) return [];

  const rows = await query<Story>(
    `SELECT id, title, summary, primary_topic, topics, article_count, source_count,
            velocity, is_breaking, created_at, updated_at, last_article_at
     FROM stories
     WHERE id = ANY($1::uuid[])`,
    [ids]
  );
  const articles = await query<ArticleSummary & { story_id: string }>(
    `SELECT story_id, id, source_id, source_name, title, summary, url, published_at
     FROM (
       SELECT a.story_id, a.id, a.source_id, s.name AS source_name, a.title, a.summary, a.url,
              a.published_at,
              ROW_NUMBER() OVER (PARTITION BY a.story_id ORDER BY a.published_at DESC) AS rn
       FROM articles a
       JOIN sources s ON a.source_id = s.id
       WHERE a.story_id = ANY($1::uuid[]) AND NOT (a.source_id = ANY($2::uuid[]))
     ) ranked
     WHERE rn <= 3
     ORDER BY published_at DESC`,
    [ids, blockedSources]
  );

  const byStory = new Map<string, ArticleSummary[]>();
  for (const { story_id, ...article } of articles) {
    const list = byStory.get(story_id) ?? [];
    list.push(article);
    byStory.set(story_id, list);
  }
  const storyById = new Map(rows.map(story => [story.id, story]));

  return ids
    .map(id => storyById.get(id))
    .filter((story): story is Story => story !== undefined)
    .map(story => ({
      ...story,
      score: scores.get(story.id) ?? 0,
      articles: byStory.get(story.id) ?? [],
    }));
}

/**
 * Get feed filtered by a specific topic.
 * Returns stories matching the topic, ordered by velocity and recency.
 * Results are cached for 60 seconds.
 * @param topic - Topic name to filter by
 * @param cursor - Pagination cursor from previous response
 * @param limit - Number of stories to return (default: 20)
 * @returns Paginated feed response for the topic
 */
export async function getTopicFeed(
  topic: string,
  cursor: string | null = null,
  limit: number = 20
): Promise<FeedResponse> {
  const startTime = process.hrtime.bigint();
  const cursorKey = cursor || '0';
  const cacheKey = CacheKeys.topicFeed(topic, cursorKey, limit);

  try {
    const { value, cached } = await getOrSet<FeedResponse>(
      cacheKey,
      config.cache.feedTtl,
      'topic_feed',
      async () => {
        return await computeTopicFeed(topic, cursor, limit);
      }
    );

    // Record metrics
    const durationNs = Number(process.hrtime.bigint() - startTime);
    const durationSec = durationNs / 1e9;
    feedGenerationDuration.observe({ type: 'topic', cached: String(cached) }, durationSec);
    feedGenerationsTotal.inc({ type: 'topic', cached: String(cached) });

    return value;
  } catch (error) {
    logger.error({ topic, cursor, limit, error }, 'Failed to get topic feed');
    throw error;
  }
}

/**
 * Compute topic feed (called on cache miss).
 */
async function computeTopicFeed(
  topic: string,
  cursor: string | null,
  limit: number
): Promise<FeedResponse> {
  const offset = cursor ? parseInt(cursor, 10) : 0;

  const stories = await query<Story>(
    `SELECT id, title, summary, primary_topic, topics, article_count, source_count,
            velocity, is_breaking, created_at, updated_at
     FROM stories
     WHERE $1 = ANY(topics)
     AND created_at > NOW() - INTERVAL '48 hours'
     ORDER BY velocity DESC, created_at DESC
     LIMIT $2 OFFSET $3`,
    [topic, limit, offset]
  );

  const enriched = await Promise.all(
    stories.map(async story => ({
      ...story,
      score: 1,
      articles: await getStoryArticles(story.id, 3),
    }))
  );

  const total = await queryOne<{ count: number }>(
    `SELECT COUNT(*) as count FROM stories
     WHERE $1 = ANY(topics) AND created_at > NOW() - INTERVAL '48 hours'`,
    [topic]
  );

  return {
    stories: enriched,
    next_cursor: offset + limit < (total?.count || 0) ? String(offset + limit) : null,
    has_more: offset + limit < (total?.count || 0),
  };
}

/**
 * Get breaking news stories.
 * Returns stories flagged as breaking (automatically by the crawler when enough
 * distinct sources cover them within the velocity window, or by an admin)
 * during the last BREAKING_TTL_HOURS, newest first. Velocity alone is not
 * used: it is only refreshed when an article arrives, so it goes stale.
 * Results are cached for 30 seconds for real-time updates.
 * @param limit - Maximum number of stories to return (default: 10)
 * @returns Array of breaking news stories with their articles
 */
export async function getBreakingNews(limit: number = 10): Promise<FeedItem[]> {
  const startTime = process.hrtime.bigint();
  const cacheKey = CacheKeys.breakingNews();

  try {
    const { value, cached } = await getOrSet<FeedItem[]>(
      cacheKey,
      config.cache.breakingTtl,
      'breaking',
      async () => {
        return await computeBreakingNews(limit);
      }
    );

    // Record metrics
    const durationNs = Number(process.hrtime.bigint() - startTime);
    const durationSec = durationNs / 1e9;
    feedGenerationDuration.observe({ type: 'breaking', cached: String(cached) }, durationSec);
    feedGenerationsTotal.inc({ type: 'breaking', cached: String(cached) });

    return value;
  } catch (error) {
    logger.error({ limit, error }, 'Failed to get breaking news');
    throw error;
  }
}

/**
 * Compute breaking news (called on cache miss).
 */
async function computeBreakingNews(limit: number): Promise<FeedItem[]> {
  const stories = await query<Story>(
    `SELECT id, title, summary, primary_topic, topics, article_count, source_count,
            velocity, is_breaking, created_at, updated_at
     FROM stories
     WHERE is_breaking = true
       AND breaking_started_at > NOW() - make_interval(hours => $2::int)
     ORDER BY breaking_started_at DESC
     LIMIT $1`,
    [limit, config.clustering.breakingTtlHours]
  );

  return Promise.all(
    stories.map(async story => ({
      ...story,
      score: story.velocity,
      articles: await getStoryArticles(story.id, 3),
    }))
  );
}

/**
 * Get trending stories based on article coverage.
 * Returns stories from the last 24 hours with the most article coverage.
 * Results are cached for 60 seconds.
 * @param limit - Maximum number of stories to return (default: 10)
 * @returns Array of trending stories with their articles
 */
export async function getTrendingStories(limit: number = 10): Promise<FeedItem[]> {
  const startTime = process.hrtime.bigint();
  const cacheKey = CacheKeys.trending();

  try {
    const { value, cached } = await getOrSet<FeedItem[]>(
      cacheKey,
      config.cache.trendingTtl,
      'trending',
      async () => {
        return await computeTrendingStories(limit);
      }
    );

    // Record metrics
    const durationNs = Number(process.hrtime.bigint() - startTime);
    const durationSec = durationNs / 1e9;
    feedGenerationDuration.observe({ type: 'trending', cached: String(cached) }, durationSec);
    feedGenerationsTotal.inc({ type: 'trending', cached: String(cached) });

    return value;
  } catch (error) {
    logger.error({ limit, error }, 'Failed to get trending stories');
    throw error;
  }
}

/**
 * Compute trending stories (called on cache miss).
 */
async function computeTrendingStories(limit: number): Promise<FeedItem[]> {
  const stories = await query<Story>(
    `SELECT id, title, summary, primary_topic, topics, article_count, source_count,
            velocity, is_breaking, created_at, updated_at
     FROM stories
     WHERE created_at > NOW() - INTERVAL '24 hours'
     ORDER BY article_count DESC, velocity DESC
     LIMIT $1`,
    [limit]
  );

  return Promise.all(
    stories.map(async story => ({
      ...story,
      score: story.article_count,
      articles: await getStoryArticles(story.id, 3),
    }))
  );
}

/**
 * Get a single story with all its articles.
 * Returns full story details with up to 20 article sources.
 * Results are cached for 2 minutes.
 * @param storyId - The story UUID to retrieve
 * @returns Story with articles, or null if not found
 */
export async function getStory(storyId: string): Promise<Story | null> {
  const cacheKey = CacheKeys.story(storyId);

  // Try cache first
  const cached = await getFromCache<Story>(cacheKey, 'story');
  if (cached) {
    return cached;
  }

  const story = await queryOne<Story>(
    `SELECT id, title, summary, primary_topic, topics, article_count, source_count,
            velocity, is_breaking, created_at, updated_at
     FROM stories
     WHERE id = $1`,
    [storyId]
  );

  if (!story) {
    return null;
  }

  story.articles = await getStoryArticles(storyId, 20);

  // Cache the result
  await setInCache(cacheKey, story, CacheTTL.story);

  return story;
}

/**
 * Get articles belonging to a story.
 * @param storyId - The story UUID
 * @param limit - Maximum number of articles to return
 * @returns Array of article summaries with source information
 */
async function getStoryArticles(storyId: string, limit: number): Promise<ArticleSummary[]> {
  return query<ArticleSummary>(
    `SELECT a.id, a.source_id, s.name as source_name, a.title, a.summary, a.url, a.published_at
     FROM articles a
     JOIN sources s ON a.source_id = s.id
     WHERE a.story_id = $1
     ORDER BY a.published_at DESC
     LIMIT $2`,
    [storyId, limit]
  );
}

/**
 * Get candidate stories for ranking.
 * Retrieves recent stories to be scored and filtered.
 * @param limit - Maximum number of candidates to retrieve
 * @returns Array of stories from the last 48 hours
 */
async function getCandidateStories(limit: number): Promise<Story[]> {
  return query<Story>(
    `SELECT s.id, s.title, s.summary, s.primary_topic, s.topics, s.article_count, s.source_count,
            s.velocity, s.is_breaking, s.created_at, s.updated_at, s.last_article_at,
            ARRAY(SELECT DISTINCT a.source_id::text FROM articles a WHERE a.story_id = s.id) AS source_ids
     FROM stories s
     WHERE s.created_at > NOW() - INTERVAL '48 hours'
     ORDER BY s.created_at DESC
     LIMIT $1`,
    [limit]
  );
}

/**
 * Get user profile for personalization.
 * Combines explicit preferences with learned topic weights from reading behavior.
 * Results are cached for 5 minutes.
 * @param userId - The user's UUID
 * @returns User profile with topic weights and source preferences
 */
async function getUserProfile(userId: string): Promise<UserProfile | null> {
  const cacheKey = CacheKeys.userPrefs(userId);

  // Try cache first
  const cached = await getFromCache<{
    preferred_topics: string[];
    preferred_sources: string[];
    blocked_sources: string[];
    topic_weights: Record<string, number>;
  }>(cacheKey, 'user_prefs');

  if (cached) {
    return {
      user_id: userId,
      topic_weights: new Map(Object.entries(cached.topic_weights)),
      preferred_sources: cached.preferred_sources,
      blocked_sources: cached.blocked_sources,
    };
  }

  const prefs = await queryOne<{
    preferred_topics: string[];
    preferred_sources: string[];
    blocked_sources: string[];
  }>(
    'SELECT preferred_topics, preferred_sources, blocked_sources FROM user_preferences WHERE user_id = $1',
    [userId]
  );

  const weights = await query<{ topic: string; weight: number }>(
    'SELECT topic, weight FROM user_topic_weights WHERE user_id = $1',
    [userId]
  );

  const topicWeights = new Map<string, number>();
  for (const w of weights) {
    topicWeights.set(w.topic, w.weight);
  }

  // Add explicit preferences with high weight
  if (prefs?.preferred_topics) {
    for (const topic of prefs.preferred_topics) {
      const current = topicWeights.get(topic) || 0;
      topicWeights.set(topic, Math.max(current, 0.8));
    }
  }

  const profile: UserProfile = {
    user_id: userId,
    topic_weights: topicWeights,
    preferred_sources: prefs?.preferred_sources || [],
    blocked_sources: prefs?.blocked_sources || [],
  };

  // Cache the profile (convert Map to object for JSON serialization)
  await setInCache(
    cacheKey,
    {
      preferred_topics: prefs?.preferred_topics || [],
      preferred_sources: profile.preferred_sources,
      blocked_sources: profile.blocked_sources,
      topic_weights: Object.fromEntries(topicWeights),
    },
    config.cache.userPrefsTtl
  );

  return profile;
}

/**
 * Velocity as of now. The stored value is articles per minute over the last
 * window, computed when the newest article arrived; it decays linearly to zero
 * as that window slides past, so a story that stopped getting coverage stops
 * looking like it is trending.
 * @param velocity - Stored velocity (articles per minute)
 * @param lastArticleAt - Arrival time of the newest article
 * @param nowMs - Current time
 * @param windowMinutes - Velocity window length
 * @returns Decayed velocity (0 once the window has fully passed)
 */
export function effectiveVelocity(
  velocity: number,
  lastArticleAt: Date | string | null | undefined,
  nowMs: number,
  windowMinutes: number = config.clustering.velocityWindowMinutes
): number {
  if (!lastArticleAt || !velocity) return 0;
  const ageMinutes = (nowMs - new Date(lastArticleAt).getTime()) / 60000;
  return Number(velocity) * Math.max(0, 1 - Math.max(0, ageMinutes) / windowMinutes);
}

/**
 * Calculate story score for feed ranking.
 * Combines multiple signals:
 * - Relevance (35%): Topic match with user interests, +0.2 for a preferred source
 * - Freshness (25%): Exponential decay with 6-hour half-life
 * - Quality (20%): Source diversity (multi-source coverage)
 * - Trending (10%): Decayed velocity (articles/minute)
 * - Breaking bonus (+0.3): Boost for breaking news
 * @param story - The story to score
 * @param profile - User profile for relevance scoring (null for anonymous)
 * @param nowMs - Current time, injectable for tests
 * @returns Score between 0 and ~1.3 (with breaking boost)
 */
function calculateStoryScore(story: Story, profile: UserProfile | null, nowMs: number): number {
  // Relevance (topic match)
  let relevance = 0.3; // Base relevance
  if (profile) {
    for (const topic of story.topics) {
      relevance += profile.topic_weights.get(topic) || 0;
    }
    const preferred = new Set(profile.preferred_sources);
    if ((story.source_ids ?? []).some(id => preferred.has(id))) {
      relevance += PREFERRED_SOURCE_BOOST;
    }
    relevance = Math.min(relevance, 1);
  }

  // Freshness: exp(-age * ln2 / 6h) halves every 6 hours
  const ageHours = (nowMs - new Date(story.created_at).getTime()) / 3600000;
  const freshness = Math.pow(0.5, Math.max(0, ageHours) / 6);

  // Quality (based on source diversity)
  const quality = Math.min(story.source_count / 5, 1);

  // Trending (velocity that decays once coverage stops)
  const trending = Math.min(effectiveVelocity(story.velocity, story.last_article_at, nowMs), 1);

  // Breaking news boost
  const breakingBoost = story.is_breaking ? 0.3 : 0;

  // Weighted combination
  return (
    relevance * 0.35 +
    freshness * 0.25 +
    quality * 0.20 +
    trending * 0.10 +
    breakingBoost
  );
}

/**
 * Apply diversity penalty to avoid topic clustering in the feed.
 * Reduces scores for repeated topics to ensure variety.
 * @param stories - Array of scored stories
 * @returns Stories with adjusted scores, re-sorted by new scores
 */
function applyDiversityPenalty(stories: FeedItem[]): FeedItem[] {
  const result: FeedItem[] = [];
  const topicCounts = new Map<string, number>();

  for (const story of stories) {
    // Count occurrences of primary topic
    const count = topicCounts.get(story.primary_topic) || 0;

    // Apply penalty for repeated topics
    const penalty = Math.pow(0.8, count);
    const adjustedScore = story.score * penalty;

    result.push({ ...story, score: adjustedScore });

    topicCounts.set(story.primary_topic, count + 1);
  }

  // Re-sort by adjusted score
  result.sort((a, b) => b.score - a.score);
  return result;
}
