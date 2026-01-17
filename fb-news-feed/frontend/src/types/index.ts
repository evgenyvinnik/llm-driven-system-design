/**
 * @fileoverview TypeScript type definitions for the News Feed frontend.
 * Defines user, post, comment, and API response types matching the backend.
 */

// User types

/**
 * User profile data returned from the API.
 */
export interface User {
  id: string;
  username: string;
  display_name: string;
  bio: string | null;
  avatar_url: string | null;
  follower_count: number;
  following_count: number;
  is_celebrity: boolean;
  role?: 'user' | 'admin';
  created_at: string;
}

/**
 * Extended user profile with follow relationship context.
 * Used when viewing another user's profile.
 */
export interface UserWithFollowStatus extends User {
  is_following: boolean;
  is_self: boolean;
}

// Post types

/**
 * Post data with embedded author info for display in feeds.
 */
export interface Post {
  id: string;
  content: string | null;
  image_url: string | null;
  post_type: 'text' | 'image' | 'link';
  privacy: 'public' | 'friends';
  like_count: number;
  comment_count: number;
  share_count: number;
  created_at: string;
  updated_at: string;
  is_liked: boolean;
  author: {
    id: string;
    username: string;
    display_name: string;
    avatar_url: string | null;
    is_celebrity?: boolean;
  };
}

// Comment types

/**
 * Comment data with embedded author info for display.
 */
export interface Comment {
  id: string;
  content: string;
  like_count: number;
  created_at: string;
  author: {
    id: string;
    username: string;
    display_name: string;
    avatar_url: string | null;
  };
}

// API Response types

/**
 * Paginated feed response with cursor-based pagination.
 */
export interface FeedResponse {
  posts: Post[];
  cursor: string | null;
  has_more: boolean;
}

/**
 * Paginated comments response.
 */
export interface CommentsResponse {
  comments: Comment[];
  has_more: boolean;
}

/**
 * Paginated users response.
 */
export interface UsersResponse {
  users: User[];
  has_more: boolean;
}

/**
 * Authentication response with user profile and session token.
 */
export interface AuthResponse {
  user: User;
  token: string;
}

// Request types

/**
 * Request payload for creating a new post.
 */
export interface CreatePostRequest {
  content: string;
  image_url?: string;
  post_type?: 'text' | 'image' | 'link';
  privacy?: 'public' | 'friends';
}

/**
 * Request payload for user login.
 */
export interface LoginRequest {
  email: string;
  password: string;
}

/**
 * Request payload for user registration.
 */
export interface RegisterRequest {
  username: string;
  email: string;
  password: string;
  display_name: string;
}
