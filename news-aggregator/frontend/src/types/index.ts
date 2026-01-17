/**
 * Frontend type definitions for the News Aggregator.
 * These types mirror the backend API response structures.
 * @module types
 */

/**
 * Represents a news article from a single source.
 * Articles belong to stories (clusters of related articles).
 */
export interface Article {
  /** Unique article identifier */
  id: string;
  /** ID of the news source this article came from */
  source_id: string;
  /** Human-readable name of the source */
  source_name: string;
  /** ID of the story cluster this article belongs to */
  story_id: string | null;
  /** Original URL of the article */
  url: string;
  /** Article headline */
  title: string;
  /** Brief summary of the article content */
  summary: string;
  /** Author name if available */
  author?: string;
  /** ISO 8601 timestamp of publication */
  published_at: string;
  /** Topic classifications for the article */
  topics: string[];
}

/**
 * Represents a news story (cluster of related articles).
 * Stories group articles from multiple sources covering the same event.
 */
export interface Story {
  /** Unique story identifier */
  id: string;
  /** Representative headline for the story */
  title: string;
  /** Brief summary of the story */
  summary: string;
  /** Main topic classification */
  primary_topic: string;
  /** All topic classifications */
  topics: string[];
  /** Number of articles in this story cluster */
  article_count: number;
  /** Number of unique sources covering this story */
  source_count: number;
  /** Rate of new articles (articles per minute) */
  velocity: number;
  /** Whether this story is marked as breaking news */
  is_breaking: boolean;
  /** ISO 8601 timestamp when story was first detected */
  created_at: string;
  /** ISO 8601 timestamp of last update */
  updated_at: string;
  /** Articles belonging to this story (when expanded) */
  articles?: ArticleSummary[];
  /** Ranking score used in feed ordering */
  score?: number;
}

/**
 * Brief article information for story listings.
 * Lighter weight than full Article for feed display.
 */
export interface ArticleSummary {
  /** Unique article identifier */
  id: string;
  /** ID of the news source */
  source_id: string;
  /** Human-readable source name */
  source_name: string;
  /** Article headline */
  title: string;
  /** Brief summary */
  summary: string;
  /** Original URL */
  url: string;
  /** ISO 8601 publication timestamp */
  published_at: string;
}

/**
 * Paginated feed response from the API.
 * Uses cursor-based pagination for efficient scrolling.
 */
export interface FeedResponse {
  /** Array of stories for this page */
  stories: Story[];
  /** Cursor for fetching next page (null if no more) */
  next_cursor: string | null;
  /** Whether more stories are available */
  has_more: boolean;
}

/**
 * Represents a user account.
 * Used for authentication and personalization.
 */
export interface User {
  /** Unique user identifier */
  id: string;
  /** Display name */
  username: string;
  /** Email address (used for login) */
  email: string;
  /** User role for access control */
  role: 'user' | 'admin';
}

/**
 * User's explicit preferences for personalization.
 * Stored in the database and used for feed ranking.
 */
export interface UserPreferences {
  /** Topics the user wants to see more of */
  preferred_topics: string[];
  /** Sources the user prefers */
  preferred_sources: string[];
  /** Sources the user wants to hide */
  blocked_sources: string[];
}

/**
 * Represents a news source configuration.
 * Used in admin dashboard for source management.
 */
export interface Source {
  /** Unique source identifier */
  id: string;
  /** Human-readable source name */
  name: string;
  /** Domain name of the source */
  domain: string;
  /** URL of the RSS/Atom feed */
  feed_url: string;
  /** Default category for articles from this source */
  category: string;
  /** Whether the source is currently being crawled */
  is_active: boolean;
  /** How often to check for new articles (in minutes) */
  crawl_frequency_minutes: number;
  /** ISO 8601 timestamp of last crawl (null if never) */
  last_crawled_at: string | null;
}

/**
 * Admin dashboard statistics.
 * Provides overview of system health and content volume.
 */
export interface AdminStats {
  /** Number of active news sources */
  sources: number;
  /** Total number of articles in the system */
  articles: number;
  /** Total number of story clusters */
  stories: number;
  /** Number of registered users */
  users: number;
  /** Articles added in the last 24 hours */
  articles_last_24h: number;
}

/**
 * Topic with story count.
 * Used for topic browser and filtering.
 */
export interface Topic {
  /** Topic name */
  topic: string;
  /** Number of stories with this topic */
  count: number;
}
