import { api } from './api';
import type { Video, HomepageRow, ContinueWatchingItem } from '../types';

interface VideosResponse {
  videos: Video[];
}

interface VideoResponse {
  video: Video;
}

interface HomepageResponse {
  rows: HomepageRow[];
}

interface ContinueWatchingResponse {
  items: ContinueWatchingItem[];
}

interface GenresResponse {
  genres: string[];
}

interface MyListCheckResponse {
  inList: boolean;
}

export const videoService = {
  // Video catalog
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

  getVideo: async (videoId: string): Promise<VideoResponse> => {
    return api.get<VideoResponse>(`/videos/${videoId}`);
  },

  getSimilar: async (videoId: string): Promise<VideosResponse> => {
    return api.get<VideosResponse>(`/videos/${videoId}/similar`);
  },

  getTrending: async (): Promise<VideosResponse> => {
    return api.get<VideosResponse>('/videos/trending');
  },

  getGenres: async (): Promise<GenresResponse> => {
    return api.get<GenresResponse>('/videos/genres');
  },

  // Browse / Homepage
  getHomepage: async (): Promise<HomepageResponse> => {
    return api.get<HomepageResponse>('/browse/homepage');
  },

  getContinueWatching: async (): Promise<ContinueWatchingResponse> => {
    return api.get<ContinueWatchingResponse>('/browse/continue-watching');
  },

  search: async (query: string): Promise<VideosResponse> => {
    return api.get<VideosResponse>(`/browse/search?q=${encodeURIComponent(query)}`);
  },

  // My List
  getMyList: async (): Promise<{ items: Video[] }> => {
    return api.get<{ items: Video[] }>('/browse/my-list');
  },

  checkMyList: async (videoId: string): Promise<MyListCheckResponse> => {
    return api.get<MyListCheckResponse>(`/browse/my-list/${videoId}/check`);
  },

  addToMyList: async (videoId: string): Promise<{ success: boolean }> => {
    return api.post<{ success: boolean }>(`/browse/my-list/${videoId}`);
  },

  removeFromMyList: async (videoId: string): Promise<{ success: boolean }> => {
    return api.del<{ success: boolean }>(`/browse/my-list/${videoId}`);
  },
};
