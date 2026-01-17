/**
 * Video content metadata.
 * Represents a movie or TV series in the catalog with all associated metadata
 * used for browsing, search, and personalization.
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
  trailerUrl: string | null;
  popularityScore: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Season within a TV series.
 * Groups episodes together for organized navigation.
 */
export interface Season {
  id: string;
  videoId: string;
  seasonNumber: number;
  title: string | null;
  description: string | null;
  releaseYear: number | null;
  episodeCount: number;
  createdAt: Date;
}

/**
 * Individual episode within a season.
 * Contains episode-specific metadata and a reference to the video file.
 */
export interface Episode {
  id: string;
  seasonId: string;
  episodeNumber: number;
  title: string;
  durationMinutes: number | null;
  description: string | null;
  thumbnailUrl: string | null;
  videoKey: string | null;
  createdAt: Date;
}

/**
 * Encoded video file at a specific quality level.
 * Links to the actual video file in object storage.
 * Multiple VideoFile records exist per video/episode for adaptive streaming.
 */
export interface VideoFile {
  id: string;
  videoId: string | null;
  episodeId: string | null;
  quality: string;
  bitrate: number | null;
  width: number | null;
  height: number | null;
  videoKey: string;
  fileSizeBytes: number | null;
  codec: string;
  container: string;
  createdAt: Date;
}

/**
 * User profile within an account.
 * Each account can have multiple profiles with independent viewing history,
 * preferences, and maturity settings (e.g., Kids profile).
 */
export interface Profile {
  id: string;
  accountId: string;
  name: string;
  avatarUrl: string | null;
  isKids: boolean;
  maturityLevel: number;
  language: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * User account (subscription holder).
 * Contains authentication credentials and subscription information.
 * One account can have multiple profiles.
 */
export interface Account {
  id: string;
  email: string;
  passwordHash: string;
  subscriptionTier: string;
  country: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Tracks viewing progress for a profile.
 * Enables "Continue Watching" feature and resume functionality.
 */
export interface ViewingProgress {
  id: string;
  profileId: string;
  videoId: string | null;
  episodeId: string | null;
  positionSeconds: number;
  durationSeconds: number;
  completed: boolean;
  lastWatchedAt: Date;
  createdAt: Date;
}

/**
 * Record of completed video watches.
 * Used for "Because you watched" recommendations and genre preference analysis.
 */
export interface WatchHistory {
  id: string;
  profileId: string;
  videoId: string | null;
  episodeId: string | null;
  watchedAt: Date;
}

/**
 * Video saved to user's watchlist.
 * Allows users to bookmark content for later viewing.
 */
export interface MyListItem {
  id: string;
  profileId: string;
  videoId: string;
  addedAt: Date;
}

/**
 * A/B test experiment configuration.
 * Defines experiment parameters, variants, and targeting rules
 * for testing UI changes, recommendation algorithms, etc.
 */
export interface Experiment {
  id: string;
  name: string;
  description: string | null;
  allocationPercent: number;
  variants: ExperimentVariant[];
  targetGroups: Record<string, unknown>;
  metrics: string[];
  status: 'draft' | 'active' | 'paused' | 'completed';
  startDate: Date | null;
  endDate: Date | null;
  createdAt: Date;
}

/**
 * Variant within an experiment.
 * Each variant has a weight determining traffic allocation
 * and a config object with variant-specific settings.
 */
export interface ExperimentVariant {
  id: string;
  name: string;
  weight: number;
  config: Record<string, unknown>;
}

/**
 * Record of a profile's assignment to an experiment variant.
 * Ensures consistent variant assignment across sessions.
 */
export interface ExperimentAllocation {
  id: string;
  experimentId: string;
  profileId: string;
  variantId: string;
  allocatedAt: Date;
}

// =========================================================
// API Response types
// =========================================================

/**
 * Video with full details including seasons and episodes for series.
 * Used for the video detail page response.
 */
export interface VideoWithDetails extends Video {
  seasons?: SeasonWithEpisodes[];
}

/**
 * Season with its episodes populated.
 */
export interface SeasonWithEpisodes extends Season {
  episodes: Episode[];
}

/**
 * Item in the "Continue Watching" row.
 * Includes video/episode info and viewing progress for resume functionality.
 */
export interface ContinueWatchingItem {
  video?: Video;
  episode?: Episode & { seasonNumber: number; videoId: string; videoTitle: string };
  positionSeconds: number;
  durationSeconds: number;
  percentComplete: number;
  lastWatchedAt: Date;
}

/**
 * A row on the homepage (e.g., "Trending Now", "Because you watched...").
 * Contains a title, row type for rendering logic, and list of videos.
 */
export interface HomepageRow {
  title: string;
  rowType: string;
  items: Video[];
}

/**
 * Streaming manifest returned to the video player.
 * Contains available quality levels with URLs and resume position.
 */
export interface StreamManifest {
  videoId: string;
  episodeId?: string;
  durationSeconds: number;
  qualities: Array<{
    quality: string;
    bitrate: number;
    width: number;
    height: number;
    url: string;
  }>;
  resumePosition?: number;
}
