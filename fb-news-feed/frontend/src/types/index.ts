// User types
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

export interface UserWithFollowStatus extends User {
  is_following: boolean;
  is_self: boolean;
}

// Post types
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
export interface FeedResponse {
  posts: Post[];
  cursor: string | null;
  has_more: boolean;
}

export interface CommentsResponse {
  comments: Comment[];
  has_more: boolean;
}

export interface UsersResponse {
  users: User[];
  has_more: boolean;
}

export interface AuthResponse {
  user: User;
  token: string;
}

// Request types
export interface CreatePostRequest {
  content: string;
  image_url?: string;
  post_type?: 'text' | 'image' | 'link';
  privacy?: 'public' | 'friends';
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface RegisterRequest {
  username: string;
  email: string;
  password: string;
  display_name: string;
}
