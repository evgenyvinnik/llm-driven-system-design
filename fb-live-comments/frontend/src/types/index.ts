/**
 * Type Definitions Module
 *
 * Shared TypeScript interfaces and types for the live comments frontend.
 * Mirrors backend types with appropriate adjustments for client-side use
 * (e.g., dates as strings from JSON).
 *
 * @module types
 */

/** Represents a user in the system */
export interface User {
  id: string;
  username: string;
  display_name: string;
  avatar_url: string | null;
  role: 'user' | 'moderator' | 'admin';
  reputation_score: number;
  is_verified: boolean;
  created_at: string;
  updated_at: string;
}

/** Represents a live stream */
export interface Stream {
  id: string;
  title: string;
  description: string | null;
  creator_id: string;
  status: 'scheduled' | 'live' | 'ended';
  viewer_count: number;
  comment_count: number;
  started_at: string;
  ended_at: string | null;
  thumbnail_url: string | null;
  video_url: string | null;
  created_at: string;
  updated_at: string;
}

/** Represents a comment with embedded user information */
export interface Comment {
  id: string;
  stream_id: string;
  user_id: string;
  content: string;
  parent_id: string | null;
  is_highlighted: boolean;
  is_pinned: boolean;
  is_hidden: boolean;
  moderation_status: 'pending' | 'approved' | 'rejected' | 'spam';
  created_at: string;
  user: {
    username: string;
    display_name: string;
    avatar_url: string | null;
    is_verified: boolean;
  };
}

/** Available reaction types */
export type ReactionType = 'like' | 'love' | 'haha' | 'wow' | 'sad' | 'angry';

/** Map of reaction types to their counts */
export interface ReactionCount {
  [key: string]: number;
}

/** WebSocket message types for real-time communication */
export type WSMessageType =
  | 'join_stream'
  | 'leave_stream'
  | 'post_comment'
  | 'delete_comment'
  | 'react'
  | 'comments_batch'
  | 'reactions_batch'
  | 'viewer_count'
  | 'error'
  | 'ping'
  | 'pong';

/** Generic WebSocket message envelope */
export interface WSMessage {
  type: WSMessageType;
  payload: unknown;
  timestamp?: number;
}

/** Payload for comments_batch message from server */
export interface CommentsBatchPayload {
  stream_id: string;
  comments: Comment[];
}

/** Payload for reactions_batch message from server */
export interface ReactionsBatchPayload {
  stream_id: string;
  counts: ReactionCount;
}

/** Payload for viewer_count message from server */
export interface ViewerCountPayload {
  stream_id: string;
  count: number;
}

/** Payload for error message from server */
export interface ErrorPayload {
  code: string;
  message: string;
}
