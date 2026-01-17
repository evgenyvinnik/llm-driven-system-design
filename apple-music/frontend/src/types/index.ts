export interface User {
  id: string;
  email: string;
  username: string;
  displayName: string;
  role: 'user' | 'admin';
  subscriptionTier: 'free' | 'student' | 'individual' | 'family';
  preferredQuality: string;
}

export interface Artist {
  id: string;
  name: string;
  bio?: string;
  image_url?: string;
  genres?: string[];
  verified: boolean;
  created_at: string;
}

export interface Album {
  id: string;
  title: string;
  artist_id: string;
  artist_name?: string;
  release_date?: string;
  album_type: 'album' | 'single' | 'ep' | 'compilation';
  genres?: string[];
  artwork_url?: string;
  total_tracks: number;
  duration_ms: number;
  explicit: boolean;
  created_at: string;
  tracks?: Track[];
}

export interface Track {
  id: string;
  isrc?: string;
  title: string;
  artist_id: string;
  artist_name?: string;
  album_id: string;
  album_title?: string;
  artwork_url?: string;
  duration_ms: number;
  track_number: number;
  disc_number: number;
  explicit: boolean;
  audio_features?: {
    tempo?: number;
    energy?: number;
    danceability?: number;
  };
  play_count: number;
  created_at: string;
  added_at?: string;
  position?: number;
}

export interface Playlist {
  id: string;
  user_id: string;
  name: string;
  description?: string;
  type: 'regular' | 'smart' | 'radio';
  is_public: boolean;
  artwork_url?: string;
  total_tracks: number;
  duration_ms: number;
  created_at: string;
  updated_at: string;
  owner_username?: string;
  owner_name?: string;
  tracks?: Track[];
}

export interface RadioStation {
  id: string;
  name: string;
  description?: string;
  artwork_url?: string;
  type: 'curated' | 'personal' | 'artist' | 'genre';
  seed_artist_id?: string;
  seed_artist_name?: string;
  seed_genre?: string;
  is_active: boolean;
  created_at: string;
  tracks?: Track[];
}

export interface BrowseSection {
  id: string;
  title: string;
  type: 'tracks' | 'albums' | 'artists' | 'playlists' | 'radio' | 'genres';
  items: (Track | Album | Artist | Playlist | RadioStation | { genre: string; track_count: number })[];
}

export interface StreamInfo {
  url: string;
  quality: string;
  format: string;
  bitrate: number;
  sampleRate?: number;
  bitDepth?: number;
  expiresAt: number;
}

export interface LibraryCounts {
  tracks: number;
  albums: number;
  artists: number;
}
