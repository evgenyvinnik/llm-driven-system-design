export interface User {
  id: string;
  email: string;
  name: string;
  role: 'user' | 'admin';
  subscriptionTier: 'free' | 'monthly' | 'yearly';
  subscriptionExpiresAt: string | null;
}

export interface Profile {
  id: string;
  name: string;
  avatar_url: string | null;
  is_kids: boolean;
}

export interface Content {
  id: string;
  title: string;
  description: string;
  duration: number;
  release_date: string;
  content_type: 'movie' | 'series' | 'episode';
  series_id?: string;
  season_number?: number;
  episode_number?: number;
  rating: string;
  genres: string[];
  thumbnail_url: string;
  banner_url?: string;
  status: 'processing' | 'ready' | 'disabled';
  featured: boolean;
  view_count: number;
  variants?: EncodedVariant[];
  audioTracks?: AudioTrack[];
  subtitles?: Subtitle[];
  episodes?: Episode[];
  seasons?: Record<number, Episode[]>;
}

export interface Episode {
  id: string;
  title: string;
  description: string;
  duration: number;
  season_number: number;
  episode_number: number;
  thumbnail_url: string;
  rating: string;
}

export interface EncodedVariant {
  id: string;
  resolution: number;
  codec: string;
  hdr: boolean;
  bitrate: number;
}

export interface AudioTrack {
  id: string;
  language: string;
  name: string;
  codec: string;
  channels: number;
}

export interface Subtitle {
  id: string;
  language: string;
  name: string;
  type: 'caption' | 'subtitle';
}

export interface WatchProgress {
  content_id: string;
  position: number;
  duration: number;
  completed: boolean;
  updated_at: string;
  title?: string;
  thumbnail_url?: string;
  content_type?: string;
  series_id?: string;
  season_number?: number;
  episode_number?: number;
}

export interface ContinueWatching extends WatchProgress {
  progressPercent: number;
  remainingMinutes: number;
  series_title?: string;
  series_thumbnail?: string;
}

export interface WatchlistItem {
  id: string;
  title: string;
  description: string;
  thumbnail_url: string;
  banner_url?: string;
  content_type: 'movie' | 'series';
  duration: number;
  rating: string;
  genres: string[];
  release_date: string;
  added_at: string;
}

export interface RecommendationSection {
  title: string;
  type: string;
  genre?: string;
  items: Content[];
}

export interface SubscriptionPlan {
  id: string;
  name: string;
  price: number;
  currency: string;
  interval: 'month' | 'year';
  savings?: string;
  features: string[];
}

export interface PlaybackInfo {
  manifestUrl: string;
  playbackToken: string;
  content: Content;
}
