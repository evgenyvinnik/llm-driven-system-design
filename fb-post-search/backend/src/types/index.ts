export type Visibility = 'public' | 'friends' | 'friends_of_friends' | 'private';
export type PostType = 'text' | 'photo' | 'video' | 'link';

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

export interface Friendship {
  id: string;
  user_id: string;
  friend_id: string;
  status: 'pending' | 'accepted' | 'blocked';
  created_at: Date;
}

export interface SearchHistory {
  id: string;
  user_id: string;
  query: string;
  filters?: Record<string, unknown>;
  results_count: number;
  created_at: Date;
}

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

export interface SearchFilters {
  date_range?: {
    start?: string;
    end?: string;
  };
  post_type?: PostType[];
  author_ids?: string[];
  visibility?: Visibility[];
}

export interface SearchRequest {
  query: string;
  filters?: SearchFilters;
  pagination?: {
    cursor?: string;
    limit?: number;
  };
  user_id?: string;
}

export interface SearchResponse {
  results: SearchResult[];
  next_cursor?: string;
  total_estimate: number;
  took_ms: number;
}

export interface SearchSuggestion {
  text: string;
  type: 'query' | 'hashtag' | 'user';
  score: number;
}
