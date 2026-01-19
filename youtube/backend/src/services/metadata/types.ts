// ============ Database Row Types ============

/**
 * @description Represents a video record as stored in the database.
 * Includes optional joined fields from the users table when fetched with channel info.
 */
export interface VideoRow {
  /** Unique identifier for the video (UUID) */
  id: string;
  /** Video title */
  title: string;
  /** Video description text */
  description: string;
  /** Duration of the video in seconds */
  duration_seconds: number;
  /** Processing status: 'pending', 'processing', 'ready', 'failed' */
  status: string;
  /** Visibility setting: 'public', 'unlisted', 'private' */
  visibility: string;
  /** URL to the video thumbnail image */
  thumbnail_url: string;
  /** Total number of views */
  view_count: number;
  /** Total number of likes */
  like_count: number;
  /** Total number of dislikes */
  dislike_count: number;
  /** Total number of comments */
  comment_count: number;
  /** Array of category names */
  categories: string[];
  /** Array of tag strings */
  tags: string[];
  /** ISO timestamp when the video was published */
  published_at: string;
  /** ISO timestamp when the video was created */
  created_at: string;
  /** ID of the channel (user) that owns this video */
  channel_id: string;
  /** Storage key for the raw uploaded video file (optional) */
  raw_video_key?: string;
  /** Channel owner's username (from joined users table) */
  username?: string;
  /** Channel display name (from joined users table) */
  channel_name?: string;
  /** Channel avatar URL (from joined users table) */
  avatar_url?: string;
  /** Channel subscriber count (from joined users table) */
  subscriber_count?: number;
}

/**
 * @description Represents a channel (user) record as stored in the database.
 */
export interface ChannelRow {
  /** Unique identifier for the channel/user (UUID) */
  id: string;
  /** Unique username for login and URL */
  username: string;
  /** User email address (optional, may be omitted for privacy) */
  email?: string;
  /** Display name for the channel */
  channel_name: string;
  /** Channel description/bio text */
  channel_description: string;
  /** URL to the channel avatar image */
  avatar_url: string;
  /** Total number of subscribers */
  subscriber_count: number;
  /** ISO timestamp when the channel was created */
  created_at: string;
}

/**
 * @description Represents a comment record as stored in the database.
 * Includes optional joined fields from the users table for author info.
 */
export interface CommentRow {
  /** Unique identifier for the comment (UUID) */
  id: string;
  /** ID of the user who wrote the comment */
  user_id: string;
  /** ID of the video this comment belongs to */
  video_id: string;
  /** Comment text content */
  text: string;
  /** ID of parent comment if this is a reply, null for top-level comments */
  parent_id: string | null;
  /** Total number of likes on this comment */
  like_count: number;
  /** Whether the comment has been edited */
  is_edited: boolean;
  /** ISO timestamp when the comment was created */
  created_at: string;
  /** Author's username (from joined users table) */
  username?: string;
  /** Author's avatar URL (from joined users table) */
  avatar_url?: string;
  /** Number of replies to this comment (computed field) */
  reply_count?: string;
}

// ============ Response Types ============

/**
 * @description API response format for video data.
 * Uses camelCase property names for JSON serialization.
 */
export interface VideoResponse {
  /** Unique identifier for the video */
  id: string;
  /** Video title */
  title: string;
  /** Video description text */
  description: string;
  /** Duration of the video in seconds */
  duration: number;
  /** Processing status: 'pending', 'processing', 'ready', 'failed' */
  status: string;
  /** Visibility setting: 'public', 'unlisted', 'private' */
  visibility: string;
  /** URL to the video thumbnail image */
  thumbnailUrl: string;
  /** Total number of views */
  viewCount: number;
  /** Total number of likes */
  likeCount: number;
  /** Total number of dislikes */
  dislikeCount: number;
  /** Total number of comments */
  commentCount: number;
  /** Array of category names */
  categories: string[];
  /** Array of tag strings */
  tags: string[];
  /** ISO timestamp when the video was published */
  publishedAt: string;
  /** ISO timestamp when the video was created */
  createdAt: string;
  /** Channel information (included when video is fetched with channel data) */
  channel?: {
    /** Channel ID */
    id: string;
    /** Channel display name */
    name: string;
    /** Channel username */
    username: string;
    /** Channel avatar URL */
    avatarUrl: string;
    /** Number of channel subscribers */
    subscriberCount: number;
  };
}

/**
 * @description API response format for channel data.
 * Uses camelCase property names for JSON serialization.
 */
export interface ChannelResponse {
  /** Unique identifier for the channel */
  id: string;
  /** Channel username for URL and login */
  username: string;
  /** Channel display name */
  name: string;
  /** Channel description/bio */
  description: string;
  /** URL to the channel avatar image */
  avatarUrl: string;
  /** Total number of subscribers */
  subscriberCount: number;
  /** ISO timestamp when the channel was created */
  createdAt: string;
  /** Number of public videos on the channel (optional, computed field) */
  videoCount?: number;
}

/**
 * @description API response format for comment data.
 * Uses camelCase property names for JSON serialization.
 */
export interface CommentResponse {
  /** Unique identifier for the comment */
  id: string;
  /** Comment text content */
  text: string;
  /** Total number of likes on this comment */
  likeCount: number;
  /** Whether the comment has been edited */
  isEdited: boolean;
  /** ISO timestamp when the comment was created */
  createdAt: string;
  /** Number of replies to this comment (optional) */
  replyCount?: number;
  /** Information about the comment author */
  user: {
    /** User ID */
    id: string;
    /** Username */
    username: string;
    /** User avatar URL */
    avatarUrl: string;
  };
  /** ID of parent comment if this is a reply, null for top-level comments */
  parentId: string | null;
}

/**
 * @description Pagination metadata for paginated API responses.
 */
export interface Pagination {
  /** Current page number (1-indexed) */
  page: number;
  /** Number of items per page */
  limit: number;
  /** Total number of items across all pages */
  total: number;
  /** Total number of pages */
  totalPages: number;
}

// ============ Options Types ============

/**
 * @description Options for filtering and paginating video queries.
 */
export interface GetVideosOptions {
  /** Page number for pagination (1-indexed, defaults to 1) */
  page?: number;
  /** Number of videos per page (defaults to 20) */
  limit?: number;
  /** Filter by channel ID */
  channelId?: string | null;
  /** Filter by processing status (defaults to 'ready') */
  status?: string;
  /** Filter by visibility setting (defaults to 'public') */
  visibility?: string;
  /** Search term to match against title and description */
  search?: string | null;
  /** Filter by category name */
  category?: string | null;
  /** Column to order results by (defaults to 'published_at') */
  orderBy?: string;
  /** Sort order: 'ASC' or 'DESC' (defaults to 'DESC') */
  order?: string;
}

/**
 * @description Partial update fields for modifying a video.
 * All fields are optional - only provided fields will be updated.
 */
export interface VideoUpdates {
  /** New video title */
  title?: string;
  /** New video description */
  description?: string;
  /** New category list */
  categories?: string[];
  /** New tag list */
  tags?: string[];
  /** New visibility setting: 'public', 'unlisted', 'private' */
  visibility?: string;
}

/**
 * @description Partial update fields for modifying a channel.
 * All fields are optional - only provided fields will be updated.
 */
export interface ChannelUpdates {
  /** New channel display name */
  channelName?: string;
  /** New channel description/bio */
  channelDescription?: string;
  /** New avatar image URL */
  avatarUrl?: string;
}

// ============ Result Types ============

/**
 * @description Result of a subscription operation.
 */
export interface SubscriptionResult {
  /** Whether the subscription is now active */
  subscribed: boolean;
  /** True if the user was already subscribed before this operation */
  alreadySubscribed?: boolean;
}

/**
 * @description Result of an unsubscription operation.
 */
export interface UnsubscriptionResult {
  /** Whether the unsubscription was successful (false if wasn't subscribed) */
  unsubscribed: boolean;
}

/**
 * @description Result of a video reaction (like/dislike) operation.
 */
export interface ReactionResult {
  /** The current reaction type ('like' or 'dislike'), or null if removed */
  reaction: string | null;
}

/**
 * @description Result of a comment like operation.
 */
export interface CommentLikeResult {
  /** Whether the comment is now liked (false means like was removed) */
  liked: boolean;
}

/**
 * @description Extended Error interface for database errors with error codes.
 */
export interface DatabaseError extends Error {
  /** PostgreSQL error code (e.g., '23505' for unique violation) */
  code?: string;
}

// ============ Helper Functions ============

/**
 * @description Transforms a database video row into the API response format.
 * Converts snake_case database fields to camelCase and optionally includes channel info.
 * @param row - The video row from the database query
 * @returns The formatted video response object for API consumption
 */
export const formatVideoResponse = (row: VideoRow): VideoResponse => ({
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
  channel: row.username
    ? {
        id: row.channel_id,
        name: row.channel_name || '',
        username: row.username,
        avatarUrl: row.avatar_url || '',
        subscriberCount: row.subscriber_count || 0,
      }
    : undefined,
});

/**
 * @description Transforms a database channel row into the API response format.
 * Converts snake_case database fields to camelCase.
 * @param row - The channel row from the database query
 * @returns The formatted channel response object for API consumption
 */
export const formatChannelResponse = (row: ChannelRow): ChannelResponse => ({
  id: row.id,
  username: row.username,
  name: row.channel_name,
  description: row.channel_description,
  avatarUrl: row.avatar_url,
  subscriberCount: row.subscriber_count,
  createdAt: row.created_at,
});

/**
 * @description Calculates a trending score for a video based on engagement and recency.
 * Uses an exponential decay function to prioritize recent content while
 * weighting different engagement metrics (views, likes, comments).
 * @param video - The video response object to calculate the score for
 * @returns A numeric trending score (higher means more trending)
 */
export const calculateTrendingScore = (video: VideoResponse): number => {
  const ageHours = (Date.now() - new Date(video.publishedAt).getTime()) / (1000 * 60 * 60);
  const decayFactor = Math.exp(-ageHours / 48); // Decay over 48 hours

  const engagementScore =
    video.viewCount * 1 + video.likeCount * 10 + video.commentCount * 20;

  return engagementScore * decayFactor;
};
