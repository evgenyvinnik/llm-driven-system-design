import { query, transaction } from '../utils/db.js';
import { cacheGet, cacheSet, cacheDelete, updateTrendingScore } from '../utils/redis.js';

// ============ Video Operations ============

// Get video by ID
export const getVideo = async (videoId) => {
  const cached = await cacheGet(`video:${videoId}`);
  if (cached) {
    return cached;
  }

  const result = await query(
    `SELECT v.*, u.username, u.channel_name, u.avatar_url, u.subscriber_count
     FROM videos v
     JOIN users u ON v.channel_id = u.id
     WHERE v.id = $1`,
    [videoId]
  );

  if (result.rows.length === 0) {
    return null;
  }

  const video = formatVideoResponse(result.rows[0]);

  // Cache for 5 minutes
  await cacheSet(`video:${videoId}`, video, 300);

  return video;
};

// Get videos with pagination
export const getVideos = async (options = {}) => {
  const {
    page = 1,
    limit = 20,
    channelId = null,
    status = 'ready',
    visibility = 'public',
    search = null,
    category = null,
    orderBy = 'published_at',
    order = 'DESC',
  } = options;

  const offset = (page - 1) * limit;
  const params = [];
  let whereClause = 'WHERE 1=1';
  let paramIndex = 1;

  if (status) {
    whereClause += ` AND v.status = $${paramIndex++}`;
    params.push(status);
  }

  if (visibility) {
    whereClause += ` AND v.visibility = $${paramIndex++}`;
    params.push(visibility);
  }

  if (channelId) {
    whereClause += ` AND v.channel_id = $${paramIndex++}`;
    params.push(channelId);
  }

  if (search) {
    whereClause += ` AND (v.title ILIKE $${paramIndex++} OR v.description ILIKE $${paramIndex++})`;
    const searchPattern = `%${search}%`;
    params.push(searchPattern, searchPattern);
  }

  if (category) {
    whereClause += ` AND $${paramIndex++} = ANY(v.categories)`;
    params.push(category);
  }

  // Validate order by column
  const validOrderColumns = ['published_at', 'view_count', 'like_count', 'created_at'];
  const orderColumn = validOrderColumns.includes(orderBy) ? orderBy : 'published_at';
  const orderDirection = order.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

  const countResult = await query(
    `SELECT COUNT(*) FROM videos v ${whereClause}`,
    params
  );

  const total = parseInt(countResult.rows[0].count, 10);

  params.push(limit, offset);

  const result = await query(
    `SELECT v.*, u.username, u.channel_name, u.avatar_url
     FROM videos v
     JOIN users u ON v.channel_id = u.id
     ${whereClause}
     ORDER BY v.${orderColumn} ${orderDirection}
     LIMIT $${paramIndex++} OFFSET $${paramIndex}`,
    params
  );

  return {
    videos: result.rows.map(formatVideoResponse),
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  };
};

// Update video
export const updateVideo = async (videoId, userId, updates) => {
  const { title, description, categories, tags, visibility } = updates;

  const result = await query(
    `UPDATE videos
     SET title = COALESCE($1, title),
         description = COALESCE($2, description),
         categories = COALESCE($3, categories),
         tags = COALESCE($4, tags),
         visibility = COALESCE($5, visibility)
     WHERE id = $6 AND channel_id = $7
     RETURNING *`,
    [title, description, categories, tags, visibility, videoId, userId]
  );

  if (result.rows.length === 0) {
    return null;
  }

  // Invalidate cache
  await cacheDelete(`video:${videoId}`);
  await cacheDelete(`stream:${videoId}`);

  return formatVideoResponse(result.rows[0]);
};

// Delete video
export const deleteVideo = async (videoId, userId) => {
  const result = await query(
    'DELETE FROM videos WHERE id = $1 AND channel_id = $2 RETURNING id',
    [videoId, userId]
  );

  if (result.rows.length === 0) {
    return false;
  }

  // Invalidate cache
  await cacheDelete(`video:${videoId}`);
  await cacheDelete(`stream:${videoId}`);

  return true;
};

// ============ Channel Operations ============

// Get channel by ID or username
export const getChannel = async (identifier) => {
  const cached = await cacheGet(`channel:${identifier}`);
  if (cached) {
    return cached;
  }

  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identifier);

  const result = await query(
    `SELECT id, username, email, channel_name, channel_description, avatar_url, subscriber_count, created_at
     FROM users
     WHERE ${isUuid ? 'id' : 'username'} = $1`,
    [identifier]
  );

  if (result.rows.length === 0) {
    return null;
  }

  const channel = formatChannelResponse(result.rows[0]);

  // Get video count
  const videoCountResult = await query(
    "SELECT COUNT(*) FROM videos WHERE channel_id = $1 AND status = 'ready' AND visibility = 'public'",
    [channel.id]
  );

  channel.videoCount = parseInt(videoCountResult.rows[0].count, 10);

  // Cache for 5 minutes
  await cacheSet(`channel:${identifier}`, channel, 300);

  return channel;
};

// Update channel
export const updateChannel = async (userId, updates) => {
  const { channelName, channelDescription, avatarUrl } = updates;

  const result = await query(
    `UPDATE users
     SET channel_name = COALESCE($1, channel_name),
         channel_description = COALESCE($2, channel_description),
         avatar_url = COALESCE($3, avatar_url)
     WHERE id = $4
     RETURNING id, username, channel_name, channel_description, avatar_url, subscriber_count`,
    [channelName, channelDescription, avatarUrl, userId]
  );

  if (result.rows.length === 0) {
    return null;
  }

  // Invalidate cache
  await cacheDelete(`channel:${userId}`);

  return formatChannelResponse(result.rows[0]);
};

// ============ Subscription Operations ============

// Subscribe to channel
export const subscribe = async (subscriberId, channelId) => {
  if (subscriberId === channelId) {
    throw new Error('Cannot subscribe to your own channel');
  }

  try {
    await query(
      'INSERT INTO subscriptions (subscriber_id, channel_id) VALUES ($1, $2)',
      [subscriberId, channelId]
    );

    // Invalidate cache
    await cacheDelete(`channel:${channelId}`);

    return { subscribed: true };
  } catch (error) {
    if (error.code === '23505') {
      // Already subscribed
      return { subscribed: true, alreadySubscribed: true };
    }
    throw error;
  }
};

// Unsubscribe from channel
export const unsubscribe = async (subscriberId, channelId) => {
  const result = await query(
    'DELETE FROM subscriptions WHERE subscriber_id = $1 AND channel_id = $2 RETURNING subscriber_id',
    [subscriberId, channelId]
  );

  // Invalidate cache
  await cacheDelete(`channel:${channelId}`);

  return { unsubscribed: result.rows.length > 0 };
};

// Check subscription status
export const isSubscribed = async (subscriberId, channelId) => {
  const result = await query(
    'SELECT 1 FROM subscriptions WHERE subscriber_id = $1 AND channel_id = $2',
    [subscriberId, channelId]
  );

  return result.rows.length > 0;
};

// Get user's subscriptions
export const getSubscriptions = async (userId, page = 1, limit = 20) => {
  const offset = (page - 1) * limit;

  const countResult = await query(
    'SELECT COUNT(*) FROM subscriptions WHERE subscriber_id = $1',
    [userId]
  );

  const total = parseInt(countResult.rows[0].count, 10);

  const result = await query(
    `SELECT u.id, u.username, u.channel_name, u.avatar_url, u.subscriber_count
     FROM subscriptions s
     JOIN users u ON s.channel_id = u.id
     WHERE s.subscriber_id = $1
     ORDER BY s.created_at DESC
     LIMIT $2 OFFSET $3`,
    [userId, limit, offset]
  );

  return {
    subscriptions: result.rows.map(formatChannelResponse),
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  };
};

// ============ Reaction Operations ============

// Like/dislike video
export const reactToVideo = async (userId, videoId, reactionType) => {
  if (!['like', 'dislike'].includes(reactionType)) {
    throw new Error('Invalid reaction type');
  }

  await transaction(async (client) => {
    // Check existing reaction
    const existing = await client.query(
      'SELECT reaction_type FROM video_reactions WHERE user_id = $1 AND video_id = $2',
      [userId, videoId]
    );

    if (existing.rows.length > 0) {
      const oldReaction = existing.rows[0].reaction_type;

      if (oldReaction === reactionType) {
        // Remove reaction
        await client.query(
          'DELETE FROM video_reactions WHERE user_id = $1 AND video_id = $2',
          [userId, videoId]
        );

        const countColumn = reactionType === 'like' ? 'like_count' : 'dislike_count';
        await client.query(
          `UPDATE videos SET ${countColumn} = ${countColumn} - 1 WHERE id = $1`,
          [videoId]
        );

        return { reaction: null };
      } else {
        // Change reaction
        await client.query(
          'UPDATE video_reactions SET reaction_type = $1 WHERE user_id = $2 AND video_id = $3',
          [reactionType, userId, videoId]
        );

        const oldColumn = oldReaction === 'like' ? 'like_count' : 'dislike_count';
        const newColumn = reactionType === 'like' ? 'like_count' : 'dislike_count';

        await client.query(
          `UPDATE videos SET ${oldColumn} = ${oldColumn} - 1, ${newColumn} = ${newColumn} + 1 WHERE id = $1`,
          [videoId]
        );
      }
    } else {
      // New reaction
      await client.query(
        'INSERT INTO video_reactions (user_id, video_id, reaction_type) VALUES ($1, $2, $3)',
        [userId, videoId, reactionType]
      );

      const countColumn = reactionType === 'like' ? 'like_count' : 'dislike_count';
      await client.query(
        `UPDATE videos SET ${countColumn} = ${countColumn} + 1 WHERE id = $1`,
        [videoId]
      );
    }
  });

  // Update trending score
  const video = await getVideo(videoId);
  if (video) {
    const score = calculateTrendingScore(video);
    await updateTrendingScore(videoId, score);
  }

  // Invalidate cache
  await cacheDelete(`video:${videoId}`);

  return { reaction: reactionType };
};

// Get user's reaction to video
export const getUserReaction = async (userId, videoId) => {
  const result = await query(
    'SELECT reaction_type FROM video_reactions WHERE user_id = $1 AND video_id = $2',
    [userId, videoId]
  );

  return result.rows.length > 0 ? result.rows[0].reaction_type : null;
};

// ============ Comment Operations ============

// Add comment
export const addComment = async (userId, videoId, text, parentId = null) => {
  const result = await transaction(async (client) => {
    const commentResult = await client.query(
      `INSERT INTO comments (user_id, video_id, text, parent_id)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [userId, videoId, text, parentId]
    );

    // Update comment count
    await client.query(
      'UPDATE videos SET comment_count = comment_count + 1 WHERE id = $1',
      [videoId]
    );

    return commentResult.rows[0];
  });

  // Get user info for response
  const userResult = await query(
    'SELECT username, avatar_url FROM users WHERE id = $1',
    [userId]
  );

  // Invalidate video cache
  await cacheDelete(`video:${videoId}`);

  return {
    id: result.id,
    text: result.text,
    likeCount: result.like_count,
    isEdited: result.is_edited,
    createdAt: result.created_at,
    user: {
      id: userId,
      username: userResult.rows[0].username,
      avatarUrl: userResult.rows[0].avatar_url,
    },
    parentId: result.parent_id,
  };
};

// Get comments for video
export const getComments = async (videoId, page = 1, limit = 20, parentId = null) => {
  const offset = (page - 1) * limit;

  const whereClause = parentId
    ? 'WHERE c.video_id = $1 AND c.parent_id = $2'
    : 'WHERE c.video_id = $1 AND c.parent_id IS NULL';

  const params = parentId ? [videoId, parentId] : [videoId];

  const countResult = await query(
    `SELECT COUNT(*) FROM comments c ${whereClause}`,
    params
  );

  const total = parseInt(countResult.rows[0].count, 10);

  params.push(limit, offset);

  const result = await query(
    `SELECT c.*, u.username, u.avatar_url,
            (SELECT COUNT(*) FROM comments WHERE parent_id = c.id) as reply_count
     FROM comments c
     JOIN users u ON c.user_id = u.id
     ${whereClause}
     ORDER BY c.like_count DESC, c.created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  return {
    comments: result.rows.map(c => ({
      id: c.id,
      text: c.text,
      likeCount: c.like_count,
      isEdited: c.is_edited,
      createdAt: c.created_at,
      replyCount: parseInt(c.reply_count, 10),
      user: {
        id: c.user_id,
        username: c.username,
        avatarUrl: c.avatar_url,
      },
      parentId: c.parent_id,
    })),
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  };
};

// Delete comment
export const deleteComment = async (commentId, userId) => {
  const result = await transaction(async (client) => {
    const comment = await client.query(
      'SELECT video_id FROM comments WHERE id = $1 AND user_id = $2',
      [commentId, userId]
    );

    if (comment.rows.length === 0) {
      return null;
    }

    const videoId = comment.rows[0].video_id;

    await client.query('DELETE FROM comments WHERE id = $1', [commentId]);

    await client.query(
      'UPDATE videos SET comment_count = comment_count - 1 WHERE id = $1',
      [videoId]
    );

    return videoId;
  });

  if (result) {
    await cacheDelete(`video:${result}`);
  }

  return result !== null;
};

// Like comment
export const likeComment = async (userId, commentId) => {
  try {
    await query(
      'INSERT INTO comment_likes (user_id, comment_id) VALUES ($1, $2)',
      [userId, commentId]
    );

    await query(
      'UPDATE comments SET like_count = like_count + 1 WHERE id = $1',
      [commentId]
    );

    return { liked: true };
  } catch (error) {
    if (error.code === '23505') {
      // Already liked, unlike
      await query(
        'DELETE FROM comment_likes WHERE user_id = $1 AND comment_id = $2',
        [userId, commentId]
      );

      await query(
        'UPDATE comments SET like_count = like_count - 1 WHERE id = $1',
        [commentId]
      );

      return { liked: false };
    }
    throw error;
  }
};

// ============ Helper Functions ============

const formatVideoResponse = (row) => ({
  id: row.id,
  title: row.title,
  description: row.description,
  duration: row.duration_seconds,
  status: row.status,
  visibility: row.visibility,
  thumbnailUrl: row.thumbnail_url,
  viewCount: row.view_count,
  likeCount: row.like_count,
  dislikeCount: row.dislike_count,
  commentCount: row.comment_count,
  categories: row.categories,
  tags: row.tags,
  publishedAt: row.published_at,
  createdAt: row.created_at,
  channel: row.username ? {
    id: row.channel_id,
    name: row.channel_name,
    username: row.username,
    avatarUrl: row.avatar_url,
    subscriberCount: row.subscriber_count,
  } : undefined,
});

const formatChannelResponse = (row) => ({
  id: row.id,
  username: row.username,
  name: row.channel_name,
  description: row.channel_description,
  avatarUrl: row.avatar_url,
  subscriberCount: row.subscriber_count,
  createdAt: row.created_at,
});

const calculateTrendingScore = (video) => {
  const ageHours = (Date.now() - new Date(video.publishedAt).getTime()) / (1000 * 60 * 60);
  const decayFactor = Math.exp(-ageHours / 48); // Decay over 48 hours

  const engagementScore = (video.viewCount * 1) +
    (video.likeCount * 10) +
    (video.commentCount * 20);

  return engagementScore * decayFactor;
};
