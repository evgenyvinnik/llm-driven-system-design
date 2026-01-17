/**
 * Video Catalog and Browse Service
 *
 * Provides access to the video catalog, personalized browsing,
 * My List management, and search functionality.
 */
import { api } from './api';
import type { Video, HomepageRow, ContinueWatchingItem } from '../types';

/** Response containing list of videos */
interface VideosResponse {
  videos: Video[];
}

/** Response containing a single video with full details */
interface VideoResponse {
  video: Video;
}

/** Response containing personalized homepage rows */
interface HomepageResponse {
  rows: HomepageRow[];
}

/** Response containing continue watching items with progress */
interface ContinueWatchingResponse {
  items: ContinueWatchingItem[];
}

/** Response containing available genres */
interface GenresResponse {
  genres: string[];
}

/** Response indicating if video is in My List */
interface MyListCheckResponse {
  inList: boolean;
}

/**
 * Video catalog and browse service.
 */
export const videoService = {
  // =========================================================
  // Video catalog endpoints
  // =========================================================

  /**
   * Gets videos with optional filters (type, genre, search, pagination).
   */
  getVideos: async (params?: {
    type?: 'movie' | 'series';
    genre?: string;
    search?: string;
    limit?: number;
    offset?: number;
  }): Promise<VideosResponse> => {
    const searchParams = new URLSearchParams();
    if (params?.type) searchParams.set('type', params.type);
    if (params?.genre) searchParams.set('genre', params.genre);
    if (params?.search) searchParams.set('search', params.search);
    if (params?.limit) searchParams.set('limit', params.limit.toString());
    if (params?.offset) searchParams.set('offset', params.offset.toString());

    const queryString = searchParams.toString();
    return api.get<VideosResponse>(`/videos${queryString ? `?${queryString}` : ''}`);
  },

  /**
   * Gets a single video with full details (seasons/episodes for series).
   */
  getVideo: async (videoId: string): Promise<VideoResponse> => {
    return api.get<VideoResponse>(`/videos/${videoId}`);
  },

  /**
   * Gets similar videos based on genre overlap.
   */
  getSimilar: async (videoId: string): Promise<VideosResponse> => {
    return api.get<VideosResponse>(`/videos/${videoId}/similar`);
  },

  /**
   * Gets trending videos sorted by popularity.
   */
  getTrending: async (): Promise<VideosResponse> => {
    return api.get<VideosResponse>('/videos/trending');
  },

  /**
   * Gets all available genres in the catalog.
   */
  getGenres: async (): Promise<GenresResponse> => {
    return api.get<GenresResponse>('/videos/genres');
  },

  // =========================================================
  // Browse / Homepage endpoints
  // =========================================================

  /**
   * Gets personalized homepage rows for the current profile.
   */
  getHomepage: async (): Promise<HomepageResponse> => {
    return api.get<HomepageResponse>('/browse/homepage');
  },

  /**
   * Gets in-progress content for continue watching row.
   */
  getContinueWatching: async (): Promise<ContinueWatchingResponse> => {
    return api.get<ContinueWatchingResponse>('/browse/continue-watching');
  },

  /**
   * Searches videos by title, description, or genre.
   */
  search: async (query: string): Promise<VideosResponse> => {
    return api.get<VideosResponse>(`/browse/search?q=${encodeURIComponent(query)}`);
  },

  // =========================================================
  // My List endpoints
  // =========================================================

  /**
   * Gets all videos in the user's My List.
   */
  getMyList: async (): Promise<{ items: Video[] }> => {
    return api.get<{ items: Video[] }>('/browse/my-list');
  },

  /**
   * Checks if a video is in the user's My List.
   */
  checkMyList: async (videoId: string): Promise<MyListCheckResponse> => {
    return api.get<MyListCheckResponse>(`/browse/my-list/${videoId}/check`);
  },

  /**
   * Adds a video to the user's My List.
   */
  addToMyList: async (videoId: string): Promise<{ success: boolean }> => {
    return api.post<{ success: boolean }>(`/browse/my-list/${videoId}`);
  },

  /**
   * Removes a video from the user's My List.
   */
  removeFromMyList: async (videoId: string): Promise<{ success: boolean }> => {
    return api.del<{ success: boolean }>(`/browse/my-list/${videoId}`);
  },
};
