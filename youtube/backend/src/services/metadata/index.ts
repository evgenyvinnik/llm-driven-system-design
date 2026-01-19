/**
 * @description Metadata service module for the YouTube-like video platform.
 * Provides operations for managing videos, channels, subscriptions, reactions, and comments.
 * All database operations include Redis caching where appropriate for performance.
 * @module services/metadata
 */

// Re-export all types
export type {
  VideoRow,
  ChannelRow,
  CommentRow,
  VideoResponse,
  ChannelResponse,
  CommentResponse,
  Pagination,
  GetVideosOptions,
  VideoUpdates,
  ChannelUpdates,
  SubscriptionResult,
  UnsubscriptionResult,
  ReactionResult,
  CommentLikeResult,
  DatabaseError,
} from './types.js';

export {
  formatVideoResponse,
  formatChannelResponse,
  calculateTrendingScore,
} from './types.js';

// Re-export video operations
export { getVideo, getVideos, updateVideo, deleteVideo } from './video.js';

// Re-export channel operations
export { getChannel, updateChannel } from './channel.js';

// Re-export subscription operations
export { subscribe, unsubscribe, isSubscribed, getSubscriptions } from './subscription.js';

// Re-export reaction operations
export { reactToVideo, getUserReaction } from './reaction.js';

// Re-export comment operations
export { addComment, getComments, deleteComment, likeComment } from './comment.js';
