const API_BASE = '/api';

async function fetchApi<T>(
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

// Auth
export const authApi = {
  login: (email: string, password: string) =>
    fetchApi<{ user: import('../types').User; token: string }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),

  register: (email: string, username: string, password: string, displayName?: string) =>
    fetchApi<{ user: import('../types').User; token: string }>('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, username, password, displayName }),
    }),

  logout: () => fetchApi<{ message: string }>('/auth/logout', { method: 'POST' }),

  me: () => fetchApi<{ user: import('../types').User }>('/auth/me'),

  updatePreferences: (data: { preferredQuality?: string; displayName?: string }) =>
    fetchApi<{ user: import('../types').User }>('/auth/preferences', {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
};

// Catalog
export const catalogApi = {
  search: (q: string, type?: string) =>
    fetchApi<{
      tracks: import('../types').Track[];
      albums: import('../types').Album[];
      artists: import('../types').Artist[];
    }>(`/catalog/search?q=${encodeURIComponent(q)}${type ? `&type=${type}` : ''}`),

  getTracks: (limit = 50, offset = 0) =>
    fetchApi<{ tracks: import('../types').Track[]; total: number }>(`/catalog/tracks?limit=${limit}&offset=${offset}`),

  getTrack: (id: string) =>
    fetchApi<import('../types').Track>(`/catalog/tracks/${id}`),

  getAlbums: (limit = 50, offset = 0) =>
    fetchApi<{ albums: import('../types').Album[]; total: number }>(`/catalog/albums?limit=${limit}&offset=${offset}`),

  getAlbum: (id: string) =>
    fetchApi<import('../types').Album>(`/catalog/albums/${id}`),

  getArtists: (limit = 50, offset = 0) =>
    fetchApi<{ artists: import('../types').Artist[]; total: number }>(`/catalog/artists?limit=${limit}&offset=${offset}`),

  getArtist: (id: string) =>
    fetchApi<import('../types').Artist & { albums: import('../types').Album[]; topTracks: import('../types').Track[] }>(`/catalog/artists/${id}`),

  getGenres: () =>
    fetchApi<{ genres: { genre: string; track_count: number }[] }>('/catalog/genres'),

  getGenreTracks: (genre: string) =>
    fetchApi<{ tracks: import('../types').Track[] }>(`/catalog/genres/${encodeURIComponent(genre)}/tracks`),
};

// Library
export const libraryApi = {
  getLibrary: (type?: string) =>
    fetchApi<{
      tracks?: import('../types').Track[];
      albums?: import('../types').Album[];
      artists?: import('../types').Artist[];
      counts?: import('../types').LibraryCounts;
      items?: (import('../types').Track | import('../types').Album | import('../types').Artist)[];
    }>(`/library${type ? `?type=${type}` : ''}`),

  addToLibrary: (itemType: string, itemId: string) =>
    fetchApi<{ message: string }>('/library', {
      method: 'POST',
      body: JSON.stringify({ itemType, itemId }),
    }),

  removeFromLibrary: (itemType: string, itemId: string) =>
    fetchApi<{ message: string }>(`/library/${itemType}/${itemId}`, { method: 'DELETE' }),

  checkInLibrary: (itemType: string, itemId: string) =>
    fetchApi<{ inLibrary: boolean }>(`/library/check/${itemType}/${itemId}`),

  getHistory: (limit = 50) =>
    fetchApi<{ history: import('../types').Track[] }>(`/library/history?limit=${limit}`),

  getRecentlyPlayed: (limit = 20) =>
    fetchApi<{ tracks: import('../types').Track[] }>(`/library/recently-played?limit=${limit}`),

  recordPlay: (trackId: string, durationPlayedMs: number, contextType?: string, contextId?: string, completed?: boolean) =>
    fetchApi<{ message: string }>('/library/history', {
      method: 'POST',
      body: JSON.stringify({ trackId, durationPlayedMs, contextType, contextId, completed }),
    }),
};

// Playlists
export const playlistApi = {
  getPlaylists: () =>
    fetchApi<{ playlists: import('../types').Playlist[] }>('/playlists'),

  getPublicPlaylists: () =>
    fetchApi<{ playlists: import('../types').Playlist[] }>('/playlists/public'),

  getPlaylist: (id: string) =>
    fetchApi<import('../types').Playlist>(`/playlists/${id}`),

  createPlaylist: (name: string, description?: string, isPublic?: boolean) =>
    fetchApi<import('../types').Playlist>('/playlists', {
      method: 'POST',
      body: JSON.stringify({ name, description, isPublic }),
    }),

  updatePlaylist: (id: string, data: { name?: string; description?: string; isPublic?: boolean }) =>
    fetchApi<import('../types').Playlist>(`/playlists/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),

  deletePlaylist: (id: string) =>
    fetchApi<{ message: string }>(`/playlists/${id}`, { method: 'DELETE' }),

  addTrack: (playlistId: string, trackId: string) =>
    fetchApi<{ message: string }>(`/playlists/${playlistId}/tracks`, {
      method: 'POST',
      body: JSON.stringify({ trackId }),
    }),

  removeTrack: (playlistId: string, trackId: string) =>
    fetchApi<{ message: string }>(`/playlists/${playlistId}/tracks/${trackId}`, { method: 'DELETE' }),
};

// Streaming
export const streamApi = {
  getStreamUrl: (trackId: string, quality?: string, network?: string) =>
    fetchApi<{ track: import('../types').Track; stream: import('../types').StreamInfo }>(
      `/stream/${trackId}?${quality ? `quality=${quality}&` : ''}${network ? `network=${network}` : ''}`
    ),

  prefetch: (trackId: string) =>
    fetchApi<{ track: import('../types').Track; stream: import('../types').StreamInfo; prefetched: boolean }>(
      '/stream/prefetch',
      { method: 'POST', body: JSON.stringify({ trackId }) }
    ),

  reportProgress: (trackId: string, position: number, duration: number, completed?: boolean) =>
    fetchApi<{ message: string }>('/stream/progress', {
      method: 'POST',
      body: JSON.stringify({ trackId, position, duration, completed }),
    }),

  getQualities: (trackId: string) =>
    fetchApi<{ qualities: { quality: string; format: string; bitrate: number }[] }>(`/stream/${trackId}/qualities`),
};

// Radio
export const radioApi = {
  getStations: () =>
    fetchApi<{ stations: import('../types').RadioStation[] }>('/radio'),

  getStation: (id: string) =>
    fetchApi<import('../types').RadioStation>(`/radio/${id}`),

  getStationTracks: (id: string, shuffle?: boolean) =>
    fetchApi<{ tracks: import('../types').Track[] }>(`/radio/${id}/tracks?shuffle=${shuffle || false}`),

  createPersonalStation: (seedType: string, seedId: string, name?: string) =>
    fetchApi<import('../types').RadioStation>('/radio/personal', {
      method: 'POST',
      body: JSON.stringify({ seedType, seedId, name }),
    }),
};

// Recommendations
export const recommendationsApi = {
  getForYou: () =>
    fetchApi<{ sections: import('../types').BrowseSection[] }>('/recommendations/for-you'),

  getSimilarTracks: (trackId: string) =>
    fetchApi<{ tracks: import('../types').Track[] }>(`/recommendations/similar/${trackId}`),

  getSimilarArtists: (artistId: string) =>
    fetchApi<{ artists: import('../types').Artist[] }>(`/recommendations/similar-artists/${artistId}`),

  getBrowse: () =>
    fetchApi<{ sections: import('../types').BrowseSection[] }>('/recommendations/browse'),
};
