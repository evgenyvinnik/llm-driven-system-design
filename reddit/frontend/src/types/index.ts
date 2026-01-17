export interface User {
  id: number;
  username: string;
  email?: string;
  karma_post: number;
  karma_comment: number;
  role: 'user' | 'admin';
  created_at?: string;
}

export interface Subreddit {
  id: number;
  name: string;
  title: string;
  description: string;
  created_by: number;
  creator_username?: string;
  subscriber_count: number;
  is_private: boolean;
  created_at: string;
  subscribed?: boolean;
}

export interface Post {
  id: number;
  subreddit_id: number;
  subreddit_name: string;
  author_id: number;
  author_username: string;
  title: string;
  content: string | null;
  url: string | null;
  score: number;
  upvotes: number;
  downvotes: number;
  comment_count: number;
  hot_score: number;
  created_at: string;
  userVote?: number;
}

export interface Comment {
  id: number;
  post_id: number;
  author_id: number;
  author_username: string;
  parent_id: number | null;
  path: string;
  depth: number;
  content: string;
  score: number;
  upvotes: number;
  downvotes: number;
  created_at: string;
  userVote?: number;
  replies: Comment[];
}

export type SortType = 'hot' | 'new' | 'top' | 'controversial';
export type CommentSortType = 'best' | 'top' | 'new' | 'controversial';
