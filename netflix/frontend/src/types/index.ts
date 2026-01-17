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

export interface Season {
  id: string;
  seasonNumber: number;
  title: string | null;
  description: string | null;
  releaseYear: number | null;
  episodeCount: number;
  episodes: Episode[];
}

export interface Episode {
  id: string;
  episodeNumber: number;
  title: string;
  durationMinutes: number | null;
  description: string | null;
  thumbnailUrl: string | null;
}

export interface Profile {
  id: string;
  name: string;
  avatarUrl: string | null;
  isKids: boolean;
  maturityLevel: number;
  language: string;
}

export interface Account {
  id: string;
  email: string;
  subscriptionTier: string;
  country: string;
}

export interface AuthState {
  account: Account | null;
  currentProfile: Profile | null;
  isAuthenticated: boolean;
}

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

export interface HomepageRow {
  title: string;
  rowType: string;
  items: Video[];
}

export interface StreamManifest {
  videoId: string;
  episodeId?: string;
  durationSeconds: number;
  qualities: StreamQuality[];
  resumePosition?: number;
}

export interface StreamQuality {
  quality: string;
  bitrate: number;
  width: number;
  height: number;
  url: string;
}

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

export interface ExperimentVariant {
  id: string;
  name: string;
  weight: number;
  config: Record<string, unknown>;
}
