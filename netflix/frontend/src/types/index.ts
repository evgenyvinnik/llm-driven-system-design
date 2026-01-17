/**
 * Frontend Type Definitions
 *
 * Shared TypeScript interfaces for the Netflix clone frontend.
 * Mirrors backend types with camelCase naming for API responses.
 */

/**
 * Video content metadata.
 * Represents a movie or TV series in the catalog.
 */
export interface Video {
  id: string;
  title: string;
  type: 'movie' | 'series';
  releaseYear: number | null;
  durationMinutes: number | null;
  rating: string | null;
  maturityLevel: number;
  genres: string[];
  description: string | null;
  posterUrl: string | null;
  backdropUrl: string | null;
  trailerUrl?: string | null;
  popularityScore: number;
  seasons?: Season[];
}

/**
 * Season within a TV series.
 */
export interface Season {
  id: string;
  seasonNumber: number;
  title: string | null;
  description: string | null;
  releaseYear: number | null;
  episodeCount: number;
  episodes: Episode[];
}

/**
 * Individual episode within a season.
 */
export interface Episode {
  id: string;
  episodeNumber: number;
  title: string;
  durationMinutes: number | null;
  description: string | null;
  thumbnailUrl: string | null;
}

/**
 * User profile within an account.
 * Each account can have multiple profiles with independent settings.
 */
export interface Profile {
  id: string;
  name: string;
  avatarUrl: string | null;
  isKids: boolean;
  maturityLevel: number;
  language: string;
}

/**
 * User account (subscription holder).
 */
export interface Account {
  id: string;
  email: string;
  subscriptionTier: string;
  country: string;
}

/**
 * Authentication state for the app.
 */
export interface AuthState {
  account: Account | null;
  currentProfile: Profile | null;
  isAuthenticated: boolean;
}

/**
 * Item in the "Continue Watching" row.
 * Includes video/episode info and viewing progress.
 */
export interface ContinueWatchingItem {
  video: {
    id: string;
    title: string;
    type: 'movie' | 'series';
    posterUrl: string | null;
    backdropUrl: string | null;
    genres: string[];
  };
  episode: {
    id: string;
    title: string;
    episodeNumber: number;
    seasonNumber: number;
    thumbnailUrl: string | null;
  } | null;
  positionSeconds: number;
  durationSeconds: number;
  percentComplete: number;
  lastWatchedAt: string;
}

/**
 * A row on the homepage.
 */
export interface HomepageRow {
  title: string;
  rowType: string;
  items: Video[];
}

/**
 * Streaming manifest for video playback.
 * Contains available quality levels and resume position.
 */
export interface StreamManifest {
  videoId: string;
  episodeId?: string;
  durationSeconds: number;
  qualities: StreamQuality[];
  resumePosition?: number;
}

/**
 * Quality level for video streaming.
 */
export interface StreamQuality {
  quality: string;
  bitrate: number;
  width: number;
  height: number;
  url: string;
}

/**
 * A/B test experiment.
 */
export interface Experiment {
  id: string;
  name: string;
  description: string | null;
  allocationPercent: number;
  variants: ExperimentVariant[];
  status: 'draft' | 'active' | 'paused' | 'completed';
  startDate: string | null;
  endDate: string | null;
}

/**
 * Variant within an experiment.
 */
export interface ExperimentVariant {
  id: string;
  name: string;
  weight: number;
  config: Record<string, unknown>;
}
