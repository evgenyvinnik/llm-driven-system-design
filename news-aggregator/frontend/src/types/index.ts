export interface Article {
  id: string;
  source_id: string;
  source_name: string;
  story_id: string | null;
  url: string;
  title: string;
  summary: string;
  author?: string;
  published_at: string;
  topics: string[];
}

export interface Story {
  id: string;
  title: string;
  summary: string;
  primary_topic: string;
  topics: string[];
  article_count: number;
  source_count: number;
  velocity: number;
  is_breaking: boolean;
  created_at: string;
  updated_at: string;
  articles?: ArticleSummary[];
  score?: number;
}

export interface ArticleSummary {
  id: string;
  source_id: string;
  source_name: string;
  title: string;
  summary: string;
  url: string;
  published_at: string;
}

export interface FeedResponse {
  stories: Story[];
  next_cursor: string | null;
  has_more: boolean;
}

export interface User {
  id: string;
  username: string;
  email: string;
  role: 'user' | 'admin';
}

export interface UserPreferences {
  preferred_topics: string[];
  preferred_sources: string[];
  blocked_sources: string[];
}

export interface Source {
  id: string;
  name: string;
  domain: string;
  feed_url: string;
  category: string;
  is_active: boolean;
  crawl_frequency_minutes: number;
  last_crawled_at: string | null;
}

export interface AdminStats {
  sources: number;
  articles: number;
  stories: number;
  users: number;
  articles_last_24h: number;
}

export interface Topic {
  topic: string;
  count: number;
}
