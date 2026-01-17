// Database types
export interface User {
  id: string;
  username: string;
  email: string;
  password_hash: string;
  display_name: string;
  bio: string | null;
  avatar_url: string | null;
  role: 'user' | 'admin';
  follower_count: number;
  following_count: number;
  is_celebrity: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface Post {
  id: string;
  author_id: string;
  content: string | null;
  image_url: string | null;
  post_type: 'text' | 'image' | 'link';
  privacy: 'public' | 'friends';
  like_count: number;
  comment_count: number;
  share_count: number;
  is_deleted: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface Friendship {
  id: string;
  follower_id: string;
  following_id: string;
  status: 'pending' | 'active' | 'blocked';
  created_at: Date;
}

export interface Like {
  id: string;
  user_id: string;
  post_id: string;
  created_at: Date;
}

export interface Comment {
  id: string;
  user_id: string;
  post_id: string;
  content: string;
  like_count: number;
  created_at: Date;
  updated_at: Date;
}

export interface FeedItem {
  id: string;
  user_id: string;
  post_id: string;
  score: number;
  created_at: Date;
}

export interface Session {
  id: string;
  user_id: string;
  token: string;
  expires_at: Date;
  created_at: Date;
}

export interface Notification {
  id: string;
  user_id: string;
  actor_id: string | null;
  type: string;
  entity_type: string | null;
  entity_id: string | null;
  is_read: boolean;
  created_at: Date;
}

export interface AffinityScore {
  id: string;
  user_id: string;
  target_user_id: string;
  score: number;
  last_interaction_at: Date | null;
  updated_at: Date;
}

// API Response types
export interface UserPublic {
  id: string;
  username: string;
  display_name: string;
  bio: string | null;
  avatar_url: string | null;
  follower_count: number;
  following_count: number;
  is_celebrity: boolean;
  created_at: Date;
}

export interface PostWithAuthor extends Post {
  author: UserPublic;
  is_liked?: boolean;
}

export interface CommentWithAuthor extends Comment {
  author: UserPublic;
}

export interface FeedResponse {
  posts: PostWithAuthor[];
  cursor: string | null;
  has_more: boolean;
}

// Request types
export interface CreatePostRequest {
  content: string;
  image_url?: string;
  post_type?: 'text' | 'image' | 'link';
  privacy?: 'public' | 'friends';
}

export interface CreateCommentRequest {
  content: string;
}

export interface UpdateUserRequest {
  display_name?: string;
  bio?: string;
  avatar_url?: string;
}

export interface RegisterRequest {
  username: string;
  email: string;
  password: string;
  display_name: string;
}

export interface LoginRequest {
  email: string;
  password: string;
}
