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

export interface CommentWithUser extends Comment {
  user: Pick<User, 'username' | 'display_name' | 'avatar_url' | 'is_verified'>;
}

export interface Reaction {
  id: string;
  stream_id: string;
  user_id: string;
  comment_id: string | null;
  reaction_type: ReactionType;
  created_at: Date;
}

export type ReactionType = 'like' | 'love' | 'haha' | 'wow' | 'sad' | 'angry';

export interface ReactionCount {
  [key: string]: number;
}

export interface UserBan {
  id: string;
  user_id: string;
  stream_id: string | null;
  banned_by: string;
  reason: string | null;
  expires_at: Date | null;
  created_at: Date;
}

// WebSocket message types
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

export interface WSMessage {
  type: WSMessageType;
  payload: unknown;
  timestamp?: number;
}

export interface JoinStreamPayload {
  stream_id: string;
  user_id: string;
}

export interface PostCommentPayload {
  stream_id: string;
  user_id: string;
  content: string;
  parent_id?: string;
}

export interface DeleteCommentPayload {
  comment_id: string;
  user_id: string;
}

export interface ReactPayload {
  stream_id: string;
  user_id: string;
  reaction_type: ReactionType;
  comment_id?: string;
}

export interface CommentsBatchPayload {
  stream_id: string;
  comments: CommentWithUser[];
}

export interface ReactionsBatchPayload {
  stream_id: string;
  counts: ReactionCount;
}

export interface ViewerCountPayload {
  stream_id: string;
  count: number;
}

export interface ErrorPayload {
  code: string;
  message: string;
}
