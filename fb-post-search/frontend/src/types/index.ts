export type Visibility = 'public' | 'friends' | 'friends_of_friends' | 'private';
export type PostType = 'text' | 'photo' | 'video' | 'link';

export interface User {
  id: string;
  username: string;
  email: string;
  display_name: string;
  avatar_url?: string;
  role: 'user' | 'admin';
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

export interface Post {
  id: string;
  author_id: string;
  author_name?: string;
  content: string;
  visibility: Visibility;
  post_type: PostType;
  media_url?: string;
  like_count: number;
  comment_count: number;
  share_count: number;
  created_at: string;
  updated_at: string;
}

export interface AdminStats {
  users: {
    total: number;
  };
  posts: {
    total_posts: number;
    posts_today: number;
    posts_this_week: number;
    by_visibility: Record<string, number>;
    by_type: Record<string, number>;
  };
  searches: {
    total: number;
  };
  elasticsearch: {
    docs_count: number;
    store_size_bytes: number;
  } | null;
}

export interface SearchHistoryEntry {
  id: string;
  query: string;
  results_count: number;
  created_at: string;
  user_id: string;
  username: string;
}
