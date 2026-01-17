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

export interface Account {
  id: string;
  email: string;
  passwordHash: string;
  subscriptionTier: string;
  country: string;
  createdAt: Date;
  updatedAt: Date;
}

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

export interface WatchHistory {
  id: string;
  profileId: string;
  videoId: string | null;
  episodeId: string | null;
  watchedAt: Date;
}

export interface MyListItem {
  id: string;
  profileId: string;
  videoId: string;
  addedAt: Date;
}

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

export interface ExperimentVariant {
  id: string;
  name: string;
  weight: number;
  config: Record<string, unknown>;
}

export interface ExperimentAllocation {
  id: string;
  experimentId: string;
  profileId: string;
  variantId: string;
  allocatedAt: Date;
}

// API Response types
export interface VideoWithDetails extends Video {
  seasons?: SeasonWithEpisodes[];
}

export interface SeasonWithEpisodes extends Season {
  episodes: Episode[];
}

export interface ContinueWatchingItem {
  video?: Video;
  episode?: Episode & { seasonNumber: number; videoId: string; videoTitle: string };
  positionSeconds: number;
  durationSeconds: number;
  percentComplete: number;
  lastWatchedAt: Date;
}

export interface HomepageRow {
  title: string;
  rowType: string;
  items: Video[];
}

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
