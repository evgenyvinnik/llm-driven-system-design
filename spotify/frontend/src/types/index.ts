export interface User {
  id: string;
  email: string;
  username: string;
  display_name: string;
  avatar_url: string | null;
  is_premium: boolean;
  role: string;
  created_at: string;
}

export interface Artist {
  id: string;
  name: string;
  bio: string | null;
  image_url: string | null;
  verified: boolean;
  monthly_listeners: number;
  created_at: string;
  albums?: Album[];
  topTracks?: Track[];
}

export interface Album {
  id: string;
  artist_id: string;
  title: string;
  release_date: string;
  cover_url: string | null;
  album_type: 'album' | 'single' | 'ep';
  total_tracks: number;
  artist_name?: string;
  tracks?: Track[];
  track_count?: number;
}

export interface Track {
  id: string;
  album_id: string;
  title: string;
  duration_ms: number;
  track_number: number;
  disc_number: number;
  explicit: boolean;
  audio_url: string | null;
  stream_count: number;
  audio_features: AudioFeatures | null;
  created_at: string;

  // Joined fields
  album_title?: string;
  album_cover_url?: string | null;
  artist_name?: string;
  artist_id?: string;

  // Playlist context
  position?: number;
  added_at?: string;
  added_by_username?: string;

  // Library context
  saved_at?: string;

  // Listening history context
  played_at?: string;

  // Artists array (when fetched with album)
  artists?: { id: string; name: string }[];
}

export interface AudioFeatures {
  tempo: number;
  energy: number;
  danceability: number;
  acousticness: number;
}

export interface Playlist {
  id: string;
  owner_id: string;
  name: string;
  description: string | null;
  cover_url: string | null;
  is_public: boolean;
  is_collaborative: boolean;
  follower_count: number;
  created_at: string;
  updated_at: string;
  owner_username?: string;
  tracks?: Track[];
  track_count?: number;
}

export interface PaginatedResponse<T> {
  [key: string]: T[] | number;
  total: number;
  limit: number;
  offset: number;
}

export interface SearchResults {
  artists?: Artist[];
  albums?: Album[];
  tracks?: Track[];
}

export type RepeatMode = 'off' | 'all' | 'one';

export interface PlaybackState {
  trackId: string | null;
  position: number;
  isPlaying: boolean;
  queue: string[];
  shuffleEnabled: boolean;
  repeatMode: RepeatMode;
  volume: number;
}
