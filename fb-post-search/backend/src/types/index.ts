/**
 * @fileoverview Core type definitions for the post search system.
 * Defines domain models, API request/response types, and shared interfaces
 * used across backend services.
 */

/**
 * Post visibility levels determining who can see a post.
 * Used for privacy-aware search filtering via visibility fingerprints.
 */
export type Visibility = 'public' | 'friends' | 'friends_of_friends' | 'private';

/**
 * Content type classification for posts.
 * Enables filtering search results by media type.
 */
export type PostType = 'text' | 'photo' | 'video' | 'link';

/**
 * User account model stored in PostgreSQL.
 * Contains authentication data and profile information.
 */
export interface User {
  id: string;
  username: string;
  email: string;
  display_name: string;
  password_hash: string;
  avatar_url?: string;
  role: 'user' | 'admin';
  created_at: Date;
  updated_at: Date;
}

/**
 * Post model stored in PostgreSQL.
 * Represents a user-created content item with engagement metrics.
 */
export interface Post {
  id: string;
  author_id: string;
  content: string;
  visibility: Visibility;
  post_type: PostType;
  media_url?: string;
  like_count: number;
  comment_count: number;
  share_count: number;
  created_at: Date;
  updated_at: Date;
}

/**
 * Friendship relationship stored in PostgreSQL.
 * Represents a directional friend connection between two users.
 */
export interface Friendship {
  id: string;
  user_id: string;
  friend_id: string;
  status: 'pending' | 'accepted' | 'blocked';
  created_at: Date;
}

/**
 * Search history record stored in PostgreSQL.
 * Tracks user search queries for analytics and personalization.
 */
export interface SearchHistory {
  id: string;
  user_id: string;
  query: string;
  filters?: Record<string, unknown>;
  results_count: number;
  created_at: Date;
}

/**
 * Elasticsearch document format for indexed posts.
 * Contains denormalized data for efficient search without database joins.
 * Includes visibility fingerprints for privacy-aware filtering.
 */
export interface PostDocument {
  post_id: string;
  author_id: string;
  author_name: string;
  content: string;
  hashtags: string[];
  mentions: string[];
  created_at: string;
  updated_at: string;
  visibility: Visibility;
  visibility_fingerprints: string[];
  post_type: PostType;
  engagement_score: number;
  like_count: number;
  comment_count: number;
  share_count: number;
  language: string;
}

/**
 * Individual search result returned to the client.
 * Contains post data with highlighted snippet and relevance score.
 */
export interface SearchResult {
  post_id: string;
  author_id: string;
  author_name: string;
  content: string;
  snippet: string;
  hashtags: string[];
  created_at: string;
  visibility: Visibility;
  post_type: PostType;
  engagement_score: number;
  like_count: number;
  comment_count: number;
  relevance_score: number;
}

/**
 * Filter criteria for narrowing search results.
 * Supports date range, post type, author, and visibility filtering.
 */
export interface SearchFilters {
  date_range?: {
    start?: string;
    end?: string;
  };
  post_type?: PostType[];
  author_ids?: string[];
  visibility?: Visibility[];
}

/**
 * Search API request payload.
 * Contains query text, optional filters, pagination cursor, and user context.
 */
export interface SearchRequest {
  query: string;
  filters?: SearchFilters;
  pagination?: {
    cursor?: string;
    limit?: number;
  };
  user_id?: string;
}

/**
 * Search API response payload.
 * Contains paginated results with metadata about total matches and timing.
 */
export interface SearchResponse {
  results: SearchResult[];
  next_cursor?: string;
  total_estimate: number;
  took_ms: number;
}

/**
 * Typeahead/autocomplete suggestion item.
 * Can represent a previous query, hashtag, or user mention.
 */
export interface SearchSuggestion {
  text: string;
  type: 'query' | 'hashtag' | 'user';
  score: number;
}
