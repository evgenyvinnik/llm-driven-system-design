import { query, queryOne } from '../db/postgres.js';
import { getCache, setCache } from '../db/redis.js';

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

interface ArticleSummary {
  id: string;
  source_id: string;
  source_name: string;
  title: string;
  summary: string;
  url: string;
  published_at: Date;
}

interface UserProfile {
  user_id: string;
  topic_weights: Map<string, number>;
  preferred_sources: string[];
  blocked_sources: string[];
}

interface FeedItem extends Story {
  score: number;
}

interface FeedResponse {
  stories: FeedItem[];
  next_cursor: string | null;
  has_more: boolean;
}

/**
 * Get personalized feed for a user
 */
export async function getPersonalizedFeed(
  userId: string | null,
  cursor: string | null = null,
  limit: number = 20
): Promise<FeedResponse> {
  // Try to get from cache first
  const cacheKey = `feed:${userId || 'anonymous'}:${cursor || '0'}:${limit}`;
  const cached = await getCache<FeedResponse>(cacheKey);
  if (cached) {
    return cached;
  }

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

  const result: FeedResponse = {
    stories: enriched,
    next_cursor: offset + limit < diversified.length ? String(offset + limit) : null,
    has_more: offset + limit < diversified.length,
  };

  // Cache for 2 minutes
  await setCache(cacheKey, result, 120);

  return result;
}

/**
 * Get feed filtered by topic
 */
export async function getTopicFeed(
  topic: string,
  cursor: string | null = null,
  limit: number = 20
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
 * Get breaking news stories
 */
export async function getBreakingNews(limit: number = 10): Promise<FeedItem[]> {
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
 * Get trending stories
 */
export async function getTrendingStories(limit: number = 10): Promise<FeedItem[]> {
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
 * Get a single story with all its articles
 */
export async function getStory(storyId: string): Promise<Story | null> {
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
  return story;
}

/**
 * Get articles for a story
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
 * Get candidate stories for ranking
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
 * Get user profile for personalization
 */
async function getUserProfile(userId: string): Promise<UserProfile | null> {
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

  return {
    user_id: userId,
    topic_weights: topicWeights,
    preferred_sources: prefs?.preferred_sources || [],
    blocked_sources: prefs?.blocked_sources || [],
  };
}

/**
 * Calculate story score for ranking
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
 * Apply diversity penalty to avoid topic clusters
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
