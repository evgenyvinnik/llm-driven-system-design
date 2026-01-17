import { query } from '../utils/db.js';
import { cacheGet, cacheSet, getTrendingVideos } from '../utils/redis.js';

// Get personalized recommendations for a user
export const getRecommendations = async (userId, limit = 20) => {
  // Check cache first
  const cacheKey = userId ? `recommendations:${userId}` : 'recommendations:anonymous';
  const cached = await cacheGet(cacheKey);
  if (cached) {
    return cached;
  }

  let recommendations;

  if (userId) {
    recommendations = await getPersonalizedRecommendations(userId, limit);
  } else {
    recommendations = await getGenericRecommendations(limit);
  }

  // Cache for 10 minutes
  await cacheSet(cacheKey, recommendations, 600);

  return recommendations;
};

// Get personalized recommendations based on watch history
const getPersonalizedRecommendations = async (userId, limit) => {
  // Get user's watch history and preferences
  const watchHistory = await query(
    `SELECT video_id, watch_percentage
     FROM watch_history
     WHERE user_id = $1
     ORDER BY watched_at DESC
     LIMIT 50`,
    [userId]
  );

  const watchedVideoIds = watchHistory.rows.map(r => r.video_id);

  // Get preferred categories from watched videos
  const categoryPreferences = await query(
    `SELECT UNNEST(categories) as category, COUNT(*) as count
     FROM videos
     WHERE id = ANY($1)
     GROUP BY category
     ORDER BY count DESC
     LIMIT 5`,
    [watchedVideoIds.length > 0 ? watchedVideoIds : ['none']]
  );

  const preferredCategories = categoryPreferences.rows.map(r => r.category);

  // Get subscribed channels
  const subscriptions = await query(
    'SELECT channel_id FROM subscriptions WHERE subscriber_id = $1',
    [userId]
  );

  const subscribedChannelIds = subscriptions.rows.map(r => r.channel_id);

  // Combine multiple recommendation sources
  const recommendations = [];

  // 1. Recent videos from subscribed channels (highest priority)
  if (subscribedChannelIds.length > 0) {
    const subscriptionVideos = await query(
      `SELECT v.*, u.username, u.channel_name, u.avatar_url
       FROM videos v
       JOIN users u ON v.channel_id = u.id
       WHERE v.channel_id = ANY($1)
         AND v.status = 'ready'
         AND v.visibility = 'public'
         AND v.id != ALL($2)
       ORDER BY v.published_at DESC
       LIMIT $3`,
      [subscribedChannelIds, watchedVideoIds.length > 0 ? watchedVideoIds : ['none'], Math.ceil(limit * 0.4)]
    );

    recommendations.push(...subscriptionVideos.rows.map(v => ({ ...v, source: 'subscription' })));
  }

  // 2. Videos from preferred categories
  if (preferredCategories.length > 0) {
    const categoryVideos = await query(
      `SELECT v.*, u.username, u.channel_name, u.avatar_url
       FROM videos v
       JOIN users u ON v.channel_id = u.id
       WHERE v.categories && $1
         AND v.status = 'ready'
         AND v.visibility = 'public'
         AND v.id != ALL($2)
       ORDER BY v.view_count DESC, v.published_at DESC
       LIMIT $3`,
      [preferredCategories, watchedVideoIds.length > 0 ? watchedVideoIds : ['none'], Math.ceil(limit * 0.3)]
    );

    recommendations.push(...categoryVideos.rows.map(v => ({ ...v, source: 'category' })));
  }

  // 3. Trending videos
  const trendingIds = await getTrendingVideos(Math.ceil(limit * 0.3));
  if (trendingIds.length > 0) {
    const trendingVideos = await query(
      `SELECT v.*, u.username, u.channel_name, u.avatar_url
       FROM videos v
       JOIN users u ON v.channel_id = u.id
       WHERE v.id = ANY($1)
         AND v.status = 'ready'
         AND v.visibility = 'public'
         AND v.id != ALL($2)`,
      [trendingIds, watchedVideoIds.length > 0 ? watchedVideoIds : ['none']]
    );

    recommendations.push(...trendingVideos.rows.map(v => ({ ...v, source: 'trending' })));
  }

  // Deduplicate and shuffle
  const uniqueRecommendations = deduplicateAndShuffle(recommendations, limit);

  return uniqueRecommendations.map(formatVideoForRecommendation);
};

// Get generic recommendations for anonymous users
const getGenericRecommendations = async (limit) => {
  // Mix of trending and recent popular videos
  const recommendations = [];

  // 1. Trending videos
  const trendingIds = await getTrendingVideos(Math.ceil(limit * 0.5));
  if (trendingIds.length > 0) {
    const trendingVideos = await query(
      `SELECT v.*, u.username, u.channel_name, u.avatar_url
       FROM videos v
       JOIN users u ON v.channel_id = u.id
       WHERE v.id = ANY($1)
         AND v.status = 'ready'
         AND v.visibility = 'public'`,
      [trendingIds]
    );

    recommendations.push(...trendingVideos.rows.map(v => ({ ...v, source: 'trending' })));
  }

  // 2. Recent popular videos
  const popularVideos = await query(
    `SELECT v.*, u.username, u.channel_name, u.avatar_url
     FROM videos v
     JOIN users u ON v.channel_id = u.id
     WHERE v.status = 'ready'
       AND v.visibility = 'public'
       AND v.published_at > NOW() - INTERVAL '7 days'
     ORDER BY v.view_count DESC
     LIMIT $1`,
    [Math.ceil(limit * 0.5)]
  );

  recommendations.push(...popularVideos.rows.map(v => ({ ...v, source: 'popular' })));

  // Deduplicate and shuffle
  const uniqueRecommendations = deduplicateAndShuffle(recommendations, limit);

  return uniqueRecommendations.map(formatVideoForRecommendation);
};

// Get trending videos
export const getTrending = async (limit = 50, category = null) => {
  const cacheKey = category ? `trending:${category}` : 'trending:all';
  const cached = await cacheGet(cacheKey);
  if (cached) {
    return cached;
  }

  let queryText = `
    SELECT v.*, u.username, u.channel_name, u.avatar_url
    FROM videos v
    JOIN users u ON v.channel_id = u.id
    WHERE v.status = 'ready'
      AND v.visibility = 'public'
      AND v.published_at > NOW() - INTERVAL '7 days'
  `;

  const params = [];

  if (category) {
    queryText += ` AND $1 = ANY(v.categories)`;
    params.push(category);
  }

  queryText += `
    ORDER BY
      (v.view_count * 1 + v.like_count * 10 + v.comment_count * 20) *
      EXP(-EXTRACT(EPOCH FROM (NOW() - v.published_at)) / (48 * 3600))
    DESC
    LIMIT $${params.length + 1}
  `;

  params.push(limit);

  const result = await query(queryText, params);

  const trending = result.rows.map(formatVideoForRecommendation);

  // Cache for 10 minutes
  await cacheSet(cacheKey, trending, 600);

  return trending;
};

// Search videos
export const searchVideos = async (searchQuery, options = {}) => {
  const {
    page = 1,
    limit = 20,
    sortBy = 'relevance', // 'relevance', 'date', 'views', 'rating'
  } = options;

  const offset = (page - 1) * limit;

  // Build search query with ranking
  let orderClause;
  switch (sortBy) {
    case 'date':
      orderClause = 'v.published_at DESC';
      break;
    case 'views':
      orderClause = 'v.view_count DESC';
      break;
    case 'rating':
      orderClause = '(v.like_count::float / NULLIF(v.like_count + v.dislike_count, 0)) DESC NULLS LAST';
      break;
    default:
      // Relevance: combine text matching with popularity
      orderClause = `
        (
          CASE WHEN v.title ILIKE $1 THEN 100 ELSE 0 END +
          CASE WHEN v.title ILIKE $2 THEN 50 ELSE 0 END +
          CASE WHEN v.description ILIKE $2 THEN 20 ELSE 0 END +
          LOG(GREATEST(v.view_count, 1))
        ) DESC
      `;
  }

  const exactMatch = searchQuery;
  const fuzzyMatch = `%${searchQuery}%`;

  const countResult = await query(
    `SELECT COUNT(*)
     FROM videos v
     WHERE v.status = 'ready'
       AND v.visibility = 'public'
       AND (v.title ILIKE $1 OR v.description ILIKE $1 OR $2 = ANY(v.tags))`,
    [fuzzyMatch, searchQuery.toLowerCase()]
  );

  const total = parseInt(countResult.rows[0].count, 10);

  const result = await query(
    `SELECT v.*, u.username, u.channel_name, u.avatar_url
     FROM videos v
     JOIN users u ON v.channel_id = u.id
     WHERE v.status = 'ready'
       AND v.visibility = 'public'
       AND (v.title ILIKE $2 OR v.description ILIKE $2 OR $3 = ANY(v.tags))
     ORDER BY ${orderClause}
     LIMIT $4 OFFSET $5`,
    [exactMatch, fuzzyMatch, searchQuery.toLowerCase(), limit, offset]
  );

  return {
    videos: result.rows.map(formatVideoForRecommendation),
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
    query: searchQuery,
  };
};

// Get subscription feed
export const getSubscriptionFeed = async (userId, page = 1, limit = 20) => {
  const offset = (page - 1) * limit;

  // Get subscribed channel IDs
  const subscriptions = await query(
    'SELECT channel_id FROM subscriptions WHERE subscriber_id = $1',
    [userId]
  );

  if (subscriptions.rows.length === 0) {
    return {
      videos: [],
      pagination: { page, limit, total: 0, totalPages: 0 },
    };
  }

  const channelIds = subscriptions.rows.map(r => r.channel_id);

  const countResult = await query(
    `SELECT COUNT(*)
     FROM videos
     WHERE channel_id = ANY($1)
       AND status = 'ready'
       AND visibility = 'public'`,
    [channelIds]
  );

  const total = parseInt(countResult.rows[0].count, 10);

  const result = await query(
    `SELECT v.*, u.username, u.channel_name, u.avatar_url
     FROM videos v
     JOIN users u ON v.channel_id = u.id
     WHERE v.channel_id = ANY($1)
       AND v.status = 'ready'
       AND v.visibility = 'public'
     ORDER BY v.published_at DESC
     LIMIT $2 OFFSET $3`,
    [channelIds, limit, offset]
  );

  return {
    videos: result.rows.map(formatVideoForRecommendation),
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  };
};

// Get watch history
export const getWatchHistory = async (userId, page = 1, limit = 20) => {
  const offset = (page - 1) * limit;

  const countResult = await query(
    'SELECT COUNT(DISTINCT video_id) FROM watch_history WHERE user_id = $1',
    [userId]
  );

  const total = parseInt(countResult.rows[0].count, 10);

  const result = await query(
    `SELECT DISTINCT ON (wh.video_id)
       v.*, u.username, u.channel_name, u.avatar_url,
       wh.watched_at, wh.watch_percentage, wh.last_position_seconds
     FROM watch_history wh
     JOIN videos v ON wh.video_id = v.id
     JOIN users u ON v.channel_id = u.id
     WHERE wh.user_id = $1
       AND v.status = 'ready'
     ORDER BY wh.video_id, wh.watched_at DESC`,
    [userId]
  );

  // Sort by watched_at after deduplication
  const sorted = result.rows.sort((a, b) =>
    new Date(b.watched_at) - new Date(a.watched_at)
  );

  const paginated = sorted.slice(offset, offset + limit);

  return {
    videos: paginated.map(v => ({
      ...formatVideoForRecommendation(v),
      watchedAt: v.watched_at,
      watchPercentage: v.watch_percentage,
      resumePosition: v.last_position_seconds,
    })),
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  };
};

// Helper functions
const deduplicateAndShuffle = (videos, limit) => {
  const seen = new Set();
  const unique = [];

  for (const video of videos) {
    if (!seen.has(video.id)) {
      seen.add(video.id);
      unique.push(video);
    }
  }

  // Fisher-Yates shuffle
  for (let i = unique.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [unique[i], unique[j]] = [unique[j], unique[i]];
  }

  return unique.slice(0, limit);
};

const formatVideoForRecommendation = (row) => ({
  id: row.id,
  title: row.title,
  description: row.description,
  duration: row.duration_seconds,
  thumbnailUrl: row.thumbnail_url,
  viewCount: row.view_count,
  likeCount: row.like_count,
  publishedAt: row.published_at,
  source: row.source,
  channel: {
    id: row.channel_id,
    name: row.channel_name,
    username: row.username,
    avatarUrl: row.avatar_url,
  },
});
