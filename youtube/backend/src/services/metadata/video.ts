import { query } from '../../utils/db.js';
import { cacheGet, cacheSet, cacheDelete } from '../../utils/redis.js';
import {
  VideoRow,
  VideoResponse,
  Pagination,
  GetVideosOptions,
  VideoUpdates,
  formatVideoResponse,
} from './types.js';

/**
 * @description Retrieves a video by its ID, with caching support.
 * First checks the Redis cache, then falls back to database query if not cached.
 * Includes channel information (username, name, avatar, subscriber count).
 * @param videoId - The UUID of the video to retrieve
 * @returns The video response object, or null if not found
 */
export const getVideo = async (videoId: string): Promise<VideoResponse | null> => {
  const cached = await cacheGet<VideoResponse>(`video:${videoId}`);
  if (cached) {
    return cached;
  }

  const result = await query<VideoRow>(
    `SELECT v.*, u.username, u.channel_name, u.avatar_url, u.subscriber_count
     FROM videos v
     JOIN users u ON v.channel_id = u.id
     WHERE v.id = $1`,
    [videoId]
  );

  if (result.rows.length === 0) {
    return null;
  }

  const row = result.rows[0];
  if (!row) {
    return null;
  }

  const video = formatVideoResponse(row);

  // Cache for 5 minutes
  await cacheSet(`video:${videoId}`, video, 300);

  return video;
};

/**
 * @description Retrieves a paginated list of videos with optional filtering and sorting.
 * Supports filtering by channel, status, visibility, search term, and category.
 * Results are sorted by the specified column and order.
 * @param options - Query options for filtering, pagination, and sorting
 * @returns Object containing the videos array and pagination metadata
 */
export const getVideos = async (
  options: GetVideosOptions = {}
): Promise<{ videos: VideoResponse[]; pagination: Pagination }> => {
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
  const params: unknown[] = [];
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

  const countResult = await query<{ count: string }>(
    `SELECT COUNT(*) FROM videos v ${whereClause}`,
    params
  );

  const countRow = countResult.rows[0];
  const total = countRow ? parseInt(countRow.count, 10) : 0;

  params.push(limit, offset);

  const result = await query<VideoRow>(
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

/**
 * @description Updates a video's metadata.
 * Only the video owner (matching channel_id) can update the video.
 * Invalidates the video cache after successful update.
 * @param videoId - The UUID of the video to update
 * @param userId - The UUID of the user attempting the update (must be the video owner)
 * @param updates - Object containing the fields to update
 * @returns The updated video response, or null if video not found or user not authorized
 */
export const updateVideo = async (
  videoId: string,
  userId: string,
  updates: VideoUpdates
): Promise<VideoResponse | null> => {
  const { title, description, categories, tags, visibility } = updates;

  const result = await query<VideoRow>(
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

  const row = result.rows[0];
  if (!row) {
    return null;
  }

  // Invalidate cache
  await cacheDelete(`video:${videoId}`);
  await cacheDelete(`stream:${videoId}`);

  return formatVideoResponse(row);
};

/**
 * @description Deletes a video from the database.
 * Only the video owner (matching channel_id) can delete the video.
 * Invalidates related caches (video and stream) after successful deletion.
 * @param videoId - The UUID of the video to delete
 * @param userId - The UUID of the user attempting the deletion (must be the video owner)
 * @returns True if the video was deleted, false if not found or user not authorized
 */
export const deleteVideo = async (videoId: string, userId: string): Promise<boolean> => {
  const result = await query<{ id: string }>(
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
