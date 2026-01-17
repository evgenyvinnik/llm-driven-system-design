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
 * Get personalized feed for a user.
 * Applies multi-signal ranking (relevance, freshness, quality, trending)
 * with diversity penalties to avoid topic clustering.
 * Results are cached for 60 seconds (configurable).
 * @param userId - User ID for personalization (null for anonymous)
 * @param cursor - Pagination cursor from previous response
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
  const cursorKey = cursor || '0';

  // Build cache key
  const cacheKey = userId
    ? CacheKeys.userFeed(userId, cursorKey, limit)
    : CacheKeys.globalFeed(cursorKey, limit);

  try {
    const { value, cached } = await getOrSet<FeedResponse>(
      cacheKey,
      config.cache.feedTtl,
      'feed',
      async () => {
        return await computePersonalizedFeed(userId, cursor, limit);
      }
    );

    // Record metrics
    const durationNs = Number(process.hrtime.bigint() - startTime);
    const durationSec = durationNs / 1e9;
    feedGenerationDuration.observe({ type: feedType, cached: String(cached) }, durationSec);
    feedGenerationsTotal.inc({ type: feedType, cached: String(cached) });

    if (cached) {
      logger.debug({ userId, cursor, limit, cached: true }, 'Feed served from cache');
    }

    return value;
  } catch (error) {
    logger.error({ userId, cursor, limit, error }, 'Failed to get personalized feed');
    throw error;
  }
}

/**
 * Compute personalized feed (called on cache miss).
 * This is the expensive operation that fetches from DB and ranks.
 */
async function computePersonalizedFeed(
  userId: string | null,
  cursor: string | null,
  limit: number
): Promise<FeedResponse> {
  // Get user profile
  let profile: UserProfile | null = null;
  if (userId) {
    profile = await getUserProfile(userId);
  }

  // Get candidate stories from last 48 hours
  const offset = cursor ? parseInt(cursor, 10) : 0;
  const candidates = await getCandidateStories(200);

  // Score and rank stories
  const scored = candidates.map(story => ({
    ...story,
    score: calculateStoryScore(story, profile),
  }));

  // Sort by score
  scored.sort((a, b) => b.score - a.score);

  // Apply diversity penalty (avoid too many stories on same topic)
  const diversified = applyDiversityPenalty(scored);

  // Paginate
  const page = diversified.slice(offset, offset + limit);

  // Enrich with article details
  const enriched = await Promise.all(
    page.map(async story => ({
      ...story,
      articles: await getStoryArticles(story.id, 3),
    }))
  );

  return {
    stories: enriched,
    next_cursor: offset + limit < diversified.length ? String(offset + limit) : null,
    has_more: offset + limit < diversified.length,
  };
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
 * Returns stories marked as breaking or with high velocity (> 0.5 articles/min).
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
     OR velocity > 0.5
     ORDER BY velocity DESC, created_at DESC
     LIMIT $1`,
    [limit]
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
    `SELECT id, title, summary, primary_topic, topics, article_count, source_count,
            velocity, is_breaking, created_at, updated_at
     FROM stories
     WHERE created_at > NOW() - INTERVAL '48 hours'
     ORDER BY created_at DESC
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
 * Calculate story score for feed ranking.
 * Combines multiple signals:
 * - Relevance (35%): Topic match with user interests
 * - Freshness (25%): Exponential decay with 6-hour half-life
 * - Quality (20%): Source diversity (multi-source coverage)
 * - Trending (10%): Story velocity (articles/minute)
 * - Breaking bonus (+30%): Boost for breaking news
 * @param story - The story to score
 * @param profile - User profile for relevance scoring (null for anonymous)
 * @returns Normalized score between 0 and ~1.3 (with breaking boost)
 */
function calculateStoryScore(story: Story, profile: UserProfile | null): number {
  // Relevance (topic match)
  let relevance = 0.3; // Base relevance
  if (profile) {
    for (const topic of story.topics) {
      relevance += profile.topic_weights.get(topic) || 0;
    }
    relevance = Math.min(relevance, 1);
  }

  // Freshness (exponential decay with 6-hour half-life)
  const ageHours = (Date.now() - new Date(story.created_at).getTime()) / 3600000;
  const freshness = Math.exp(-ageHours / 6);

  // Quality (based on source diversity)
  const quality = Math.min(story.source_count / 5, 1);

  // Trending (velocity)
  const trending = Math.min(story.velocity, 1);

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
