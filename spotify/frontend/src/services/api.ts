const API_BASE = '/api';

async function request<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const response = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(error.error || 'Request failed');
  }

  return response.json();
}

// Auth API
export const authApi = {
  login: (email: string, password: string) =>
    request<{ user: import('../types').User }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),

  register: (email: string, password: string, username: string, displayName?: string) =>
    request<{ user: import('../types').User }>('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password, username, displayName }),
    }),

  logout: () =>
    request<{ success: boolean }>('/auth/logout', { method: 'POST' }),

  getMe: () =>
    request<{ user: import('../types').User }>('/auth/me'),
};

// Catalog API
export const catalogApi = {
  getArtists: (params: { limit?: number; offset?: number; search?: string } = {}) => {
    const searchParams = new URLSearchParams();
    if (params.limit) searchParams.set('limit', params.limit.toString());
    if (params.offset) searchParams.set('offset', params.offset.toString());
    if (params.search) searchParams.set('search', params.search);
    return request<{ artists: import('../types').Artist[]; total: number }>(`/catalog/artists?${searchParams}`);
  },

  getArtist: (id: string) =>
    request<import('../types').Artist>(`/catalog/artists/${id}`),

  getAlbums: (params: { limit?: number; offset?: number; search?: string; artistId?: string } = {}) => {
    const searchParams = new URLSearchParams();
    if (params.limit) searchParams.set('limit', params.limit.toString());
    if (params.offset) searchParams.set('offset', params.offset.toString());
    if (params.search) searchParams.set('search', params.search);
    if (params.artistId) searchParams.set('artistId', params.artistId);
    return request<{ albums: import('../types').Album[]; total: number }>(`/catalog/albums?${searchParams}`);
  },

  getAlbum: (id: string) =>
    request<import('../types').Album>(`/catalog/albums/${id}`),

  getTrack: (id: string) =>
    request<import('../types').Track>(`/catalog/tracks/${id}`),

  getNewReleases: (limit = 20) =>
    request<{ albums: import('../types').Album[] }>(`/catalog/new-releases?limit=${limit}`),

  getFeatured: (limit = 20) =>
    request<{ tracks: import('../types').Track[] }>(`/catalog/featured?limit=${limit}`),

  search: (q: string, params: { limit?: number; type?: string } = {}) => {
    const searchParams = new URLSearchParams({ q });
    if (params.limit) searchParams.set('limit', params.limit.toString());
    if (params.type) searchParams.set('type', params.type);
    return request<import('../types').SearchResults>(`/catalog/search?${searchParams}`);
  },
};

// Library API
export const libraryApi = {
  getLikedSongs: (params: { limit?: number; offset?: number } = {}) => {
    const searchParams = new URLSearchParams();
    if (params.limit) searchParams.set('limit', params.limit.toString());
    if (params.offset) searchParams.set('offset', params.offset.toString());
    return request<{ tracks: import('../types').Track[]; total: number }>(`/library/tracks?${searchParams}`);
  },

  likeTrack: (trackId: string) =>
    request<{ saved: boolean }>(`/library/tracks/${trackId}`, { method: 'PUT' }),

  unlikeTrack: (trackId: string) =>
    request<{ saved: boolean }>(`/library/tracks/${trackId}`, { method: 'DELETE' }),

  checkTracksLiked: (trackIds: string[]) =>
    request<Record<string, boolean>>(`/library/tracks/contains?ids=${trackIds.join(',')}`),

  getSavedAlbums: (params: { limit?: number; offset?: number } = {}) => {
    const searchParams = new URLSearchParams();
    if (params.limit) searchParams.set('limit', params.limit.toString());
    if (params.offset) searchParams.set('offset', params.offset.toString());
    return request<{ albums: import('../types').Album[]; total: number }>(`/library/albums?${searchParams}`);
  },

  saveAlbum: (albumId: string) =>
    request<{ saved: boolean }>(`/library/albums/${albumId}`, { method: 'PUT' }),

  unsaveAlbum: (albumId: string) =>
    request<{ saved: boolean }>(`/library/albums/${albumId}`, { method: 'DELETE' }),

  getFollowedArtists: (params: { limit?: number; offset?: number } = {}) => {
    const searchParams = new URLSearchParams();
    if (params.limit) searchParams.set('limit', params.limit.toString());
    if (params.offset) searchParams.set('offset', params.offset.toString());
    return request<{ artists: import('../types').Artist[]; total: number }>(`/library/artists?${searchParams}`);
  },

  followArtist: (artistId: string) =>
    request<{ saved: boolean }>(`/library/artists/${artistId}`, { method: 'PUT' }),

  unfollowArtist: (artistId: string) =>
    request<{ saved: boolean }>(`/library/artists/${artistId}`, { method: 'DELETE' }),
};

// Playlist API
export const playlistApi = {
  getMyPlaylists: (params: { limit?: number; offset?: number } = {}) => {
    const searchParams = new URLSearchParams();
    if (params.limit) searchParams.set('limit', params.limit.toString());
    if (params.offset) searchParams.set('offset', params.offset.toString());
    return request<{ playlists: import('../types').Playlist[]; total: number }>(`/playlists/me?${searchParams}`);
  },

  getPlaylist: (id: string) =>
    request<import('../types').Playlist>(`/playlists/${id}`),

  createPlaylist: (name: string, description?: string, isPublic = true) =>
    request<import('../types').Playlist>('/playlists', {
      method: 'POST',
      body: JSON.stringify({ name, description, isPublic }),
    }),

  updatePlaylist: (id: string, updates: { name?: string; description?: string; is_public?: boolean }) =>
    request<import('../types').Playlist>(`/playlists/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(updates),
    }),

  deletePlaylist: (id: string) =>
    request<{ deleted: boolean }>(`/playlists/${id}`, { method: 'DELETE' }),

  addTrackToPlaylist: (playlistId: string, trackId: string) =>
    request<{ added: boolean }>(`/playlists/${playlistId}/tracks`, {
      method: 'POST',
      body: JSON.stringify({ trackId }),
    }),

  removeTrackFromPlaylist: (playlistId: string, trackId: string) =>
    request<{ removed: boolean }>(`/playlists/${playlistId}/tracks/${trackId}`, { method: 'DELETE' }),

  getPublicPlaylists: (params: { limit?: number; offset?: number } = {}) => {
    const searchParams = new URLSearchParams();
    if (params.limit) searchParams.set('limit', params.limit.toString());
    if (params.offset) searchParams.set('offset', params.offset.toString());
    return request<{ playlists: import('../types').Playlist[] }>(`/playlists/public?${searchParams}`);
  },
};

// Playback API
export const playbackApi = {
  getStreamUrl: (trackId: string) =>
    request<{ url: string; expiresAt: number }>(`/playback/stream/${trackId}`),

  recordEvent: (trackId: string, eventType: string, positionMs?: number, deviceType = 'web') =>
    request<{ recorded: boolean }>('/playback/event', {
      method: 'POST',
      body: JSON.stringify({ trackId, eventType, positionMs, deviceType }),
    }),

  getRecentlyPlayed: (limit = 50) =>
    request<{ tracks: import('../types').Track[] }>(`/playback/recently-played?limit=${limit}`),

  saveState: (state: import('../types').PlaybackState) =>
    request<{ saved: boolean }>('/playback/state', {
      method: 'PUT',
      body: JSON.stringify(state),
    }),

  getState: () =>
    request<import('../types').PlaybackState | null>('/playback/state'),
};

// Recommendations API
export const recommendationsApi = {
  getForYou: (limit = 30) =>
    request<{ tracks: import('../types').Track[] }>(`/recommendations/for-you?limit=${limit}`),

  getDiscoverWeekly: () =>
    request<{ name: string; description: string; tracks: import('../types').Track[] }>('/recommendations/discover-weekly'),

  getPopular: (limit = 30) =>
    request<{ tracks: import('../types').Track[] }>(`/recommendations/popular?limit=${limit}`),

  getSimilar: (trackId: string, limit = 20) =>
    request<{ tracks: import('../types').Track[] }>(`/recommendations/similar/${trackId}?limit=${limit}`),

  getArtistRadio: (artistId: string, limit = 50) =>
    request<{ tracks: import('../types').Track[] }>(`/recommendations/radio/artist/${artistId}?limit=${limit}`),
};
