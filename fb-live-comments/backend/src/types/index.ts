/**
 * Type Definitions Module
 *
 * Shared TypeScript interfaces and types for the live comments backend.
 * Defines data models for users, streams, comments, reactions, and
 * WebSocket message structures.
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
  created_at: Date;
  updated_at: Date;
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
  started_at: Date;
  ended_at: Date | null;
  thumbnail_url: string | null;
  video_url: string | null;
  created_at: Date;
  updated_at: Date;
}

/** Represents a comment on a stream */
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
  created_at: Date;
}

/** Comment with embedded user information for API responses */
export interface CommentWithUser extends Comment {
  user: Pick<User, 'username' | 'display_name' | 'avatar_url' | 'is_verified'>;
}

/** Represents a reaction to a stream or comment */
export interface Reaction {
  id: string;
  stream_id: string;
  user_id: string;
  comment_id: string | null;
  reaction_type: ReactionType;
  created_at: Date;
}

/** Available reaction types */
export type ReactionType = 'like' | 'love' | 'haha' | 'wow' | 'sad' | 'angry';

/** Map of reaction types to their counts */
export interface ReactionCount {
  [key: string]: number;
}

/** Represents a user ban record */
export interface UserBan {
  id: string;
  user_id: string;
  stream_id: string | null;
  banned_by: string;
  reason: string | null;
  expires_at: Date | null;
  created_at: Date;
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

/** Payload for join_stream message */
export interface JoinStreamPayload {
  stream_id: string;
  user_id: string;
}

/** Payload for post_comment message */
export interface PostCommentPayload {
  stream_id: string;
  user_id: string;
  content: string;
  parent_id?: string;
}

/** Payload for delete_comment message */
export interface DeleteCommentPayload {
  comment_id: string;
  user_id: string;
}

/** Payload for react message */
export interface ReactPayload {
  stream_id: string;
  user_id: string;
  reaction_type: ReactionType;
  comment_id?: string;
}

/** Payload for comments_batch message (server to client) */
export interface CommentsBatchPayload {
  stream_id: string;
  comments: CommentWithUser[];
}

/** Payload for reactions_batch message (server to client) */
export interface ReactionsBatchPayload {
  stream_id: string;
  counts: ReactionCount;
}

/** Payload for viewer_count message */
export interface ViewerCountPayload {
  stream_id: string;
  count: number;
}

/** Payload for error message */
export interface ErrorPayload {
  code: string;
  message: string;
}
