/**
 * Core type definitions for the Apple TV+ streaming application.
 * These types are shared across the frontend for API responses and state management.
 */

/**
 * Authenticated user account information.
 * Represents a registered user with subscription status.
 */
export interface User {
  /** Unique user identifier */
  id: string;
  /** User's email address (used for login) */
  email: string;
  /** Display name */
  name: string;
  /** User role for access control */
  role: 'user' | 'admin';
  /** Current subscription plan tier */
  subscriptionTier: 'free' | 'monthly' | 'yearly';
  /** Subscription expiration date or null if free tier */
  subscriptionExpiresAt: string | null;
}

/**
 * User profile for multi-profile support.
 * Each account can have multiple profiles with separate watch histories.
 */
export interface Profile {
  /** Unique profile identifier */
  id: string;
  /** Profile display name */
  name: string;
  /** Optional custom avatar URL */
  avatar_url: string | null;
  /** Whether this is a kids profile with content restrictions */
  is_kids: boolean;
}

/**
 * Content item representing a movie, series, or episode.
 * Core entity for the streaming catalog.
 */
export interface Content {
  /** Unique content identifier */
  id: string;
  /** Display title */
  title: string;
  /** Full description/synopsis */
  description: string;
  /** Duration in seconds */
  duration: number;
  /** ISO date string of release */
  release_date: string;
  /** Type of content */
  content_type: 'movie' | 'series' | 'episode';
  /** Parent series ID (for episodes only) */
  series_id?: string;
  /** Season number (for episodes only) */
  season_number?: number;
  /** Episode number within season (for episodes only) */
  episode_number?: number;
  /** Content rating (e.g., "PG-13", "TV-MA") */
  rating: string;
  /** List of genre tags */
  genres: string[];
  /** URL for thumbnail image */
  thumbnail_url: string;
  /** URL for banner/hero image */
  banner_url?: string;
  /** Processing status for transcoding pipeline */
  status: 'processing' | 'ready' | 'disabled';
  /** Whether content is featured on home page */
  featured: boolean;
  /** Total number of views */
  view_count: number;
  /** Available video quality variants */
  variants?: EncodedVariant[];
  /** Available audio tracks */
  audioTracks?: AudioTrack[];
  /** Available subtitles/captions */
  subtitles?: Subtitle[];
  /** Episodes (for series detail view) */
  episodes?: Episode[];
  /** Episodes grouped by season number */
  seasons?: Record<number, Episode[]>;
}

/**
 * Episode within a TV series.
 */
export interface Episode {
  /** Unique episode identifier */
  id: string;
  /** Episode title */
  title: string;
  /** Episode description/synopsis */
  description: string;
  /** Duration in seconds */
  duration: number;
  /** Season number */
  season_number: number;
  /** Episode number within season */
  episode_number: number;
  /** Thumbnail image URL */
  thumbnail_url: string;
  /** Content rating */
  rating: string;
}

/**
 * Encoded video variant for adaptive bitrate streaming.
 * Each variant represents a different quality level.
 */
export interface EncodedVariant {
  /** Unique variant identifier */
  id: string;
  /** Video height in pixels (e.g., 2160 for 4K) */
  resolution: number;
  /** Video codec (e.g., "hevc", "h264") */
  codec: string;
  /** Whether variant includes HDR metadata */
  hdr: boolean;
  /** Bitrate in kilobits per second */
  bitrate: number;
}

/**
 * Audio track option for content playback.
 */
export interface AudioTrack {
  /** Unique audio track identifier */
  id: string;
  /** ISO language code */
  language: string;
  /** Display name (e.g., "English", "Spanish (Latin America)") */
  name: string;
  /** Audio codec */
  codec: string;
  /** Number of audio channels (e.g., 2 for stereo, 6 for 5.1) */
  channels: number;
}

/**
 * Subtitle/caption track for content playback.
 */
export interface Subtitle {
  /** Unique subtitle track identifier */
  id: string;
  /** ISO language code */
  language: string;
  /** Display name */
  name: string;
  /** Track type: caption includes audio descriptions, subtitle is dialogue only */
  type: 'caption' | 'subtitle';
}

/**
 * Watch progress for a content item.
 * Used for "Continue Watching" and resume functionality.
 */
export interface WatchProgress {
  /** Content item identifier */
  content_id: string;
  /** Current position in seconds */
  position: number;
  /** Total duration in seconds */
  duration: number;
  /** Whether content has been completed (>95%) */
  completed: boolean;
  /** ISO timestamp of last progress update */
  updated_at: string;
  /** Content title (for display) */
  title?: string;
  /** Thumbnail URL (for display) */
  thumbnail_url?: string;
  /** Content type (for display) */
  content_type?: string;
  /** Series ID (for episodes) */
  series_id?: string;
  /** Season number (for episodes) */
  season_number?: number;
  /** Episode number (for episodes) */
  episode_number?: number;
}

/**
 * Continue watching item with computed progress values.
 * Extends WatchProgress with UI-friendly calculated fields.
 */
export interface ContinueWatching extends WatchProgress {
  /** Progress as percentage (0-100) */
  progressPercent: number;
  /** Remaining time in minutes */
  remainingMinutes: number;
  /** Series title (for episode display) */
  series_title?: string;
  /** Series thumbnail (for episode display) */
  series_thumbnail?: string;
}

/**
 * Watchlist (My List) item for saved content.
 */
export interface WatchlistItem {
  /** Content identifier */
  id: string;
  /** Content title */
  title: string;
  /** Content description */
  description: string;
  /** Thumbnail URL */
  thumbnail_url: string;
  /** Banner URL */
  banner_url?: string;
  /** Content type (only movies and series, not episodes) */
  content_type: 'movie' | 'series';
  /** Duration in seconds */
  duration: number;
  /** Content rating */
  rating: string;
  /** Genre tags */
  genres: string[];
  /** Release date */
  release_date: string;
  /** ISO timestamp when added to watchlist */
  added_at: string;
}

/**
 * Recommendation section for personalized content discovery.
 * Groups related content with a section title.
 */
export interface RecommendationSection {
  /** Section title (e.g., "Trending Now", "Because You Watched X") */
  title: string;
  /** Section type for analytics/styling */
  type: string;
  /** Optional genre for genre-based sections */
  genre?: string;
  /** Content items in this section */
  items: Content[];
}

/**
 * Subscription plan for pricing display.
 */
export interface SubscriptionPlan {
  /** Plan identifier for subscription API */
  id: string;
  /** Display name (e.g., "Monthly", "Yearly") */
  name: string;
  /** Price in the specified currency */
  price: number;
  /** Currency code (e.g., "USD") */
  currency: string;
  /** Billing interval */
  interval: 'month' | 'year';
  /** Savings message for yearly plans */
  savings?: string;
  /** List of included features */
  features: string[];
}

/**
 * Playback information returned when starting video playback.
 * Contains streaming URLs and content metadata.
 */
export interface PlaybackInfo {
  /** HLS master playlist URL */
  manifestUrl: string;
  /** DRM playback token for content protection */
  playbackToken: string;
  /** Full content metadata */
  content: Content;
}
