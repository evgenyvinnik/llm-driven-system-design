import { create } from 'zustand';
import { Video, RecommendedVideo, PaginatedResponse, SearchResponse } from '../types';
import { api } from '../services/api';

interface VideoState {
  videos: Video[];
  currentVideo: Video | null;
  recommendations: RecommendedVideo[];
  trending: Video[];
  searchResults: Video[];
  searchQuery: string;
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  } | null;
  isLoading: boolean;
  error: string | null;

  fetchVideos: (options?: { page?: number; limit?: number; channelId?: string }) => Promise<void>;
  fetchVideo: (videoId: string) => Promise<void>;
  fetchRecommendations: () => Promise<void>;
  fetchTrending: () => Promise<void>;
  searchVideos: (query: string, page?: number) => Promise<void>;
  clearSearch: () => void;
  updateVideo: (videoId: string, updates: Partial<Video>) => Promise<void>;
  deleteVideo: (videoId: string) => Promise<boolean>;
  reactToVideo: (videoId: string, reaction: 'like' | 'dislike') => Promise<void>;
  recordView: (videoId: string) => Promise<void>;
}

export const useVideoStore = create<VideoState>((set, get) => ({
  videos: [],
  currentVideo: null,
  recommendations: [],
  trending: [],
  searchResults: [],
  searchQuery: '',
  pagination: null,
  isLoading: false,
  error: null,

  fetchVideos: async (options = {}) => {
    set({ isLoading: true, error: null });
    try {
      const params = new URLSearchParams();
      if (options.page) params.set('page', options.page.toString());
      if (options.limit) params.set('limit', options.limit.toString());
      if (options.channelId) params.set('channelId', options.channelId);

      const response = await api.get<PaginatedResponse<Video>>(
        `/videos?${params.toString()}`
      );

      set({
        videos: response.videos || [],
        pagination: response.pagination,
        isLoading: false,
      });
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : 'Failed to fetch videos',
        isLoading: false,
      });
    }
  },

  fetchVideo: async (videoId) => {
    set({ isLoading: true, error: null });
    try {
      const video = await api.get<Video>(`/videos/${videoId}`);
      set({ currentVideo: video, isLoading: false });
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : 'Failed to fetch video',
        isLoading: false,
      });
    }
  },

  fetchRecommendations: async () => {
    try {
      const response = await api.get<{ videos: RecommendedVideo[] }>('/feed/recommendations');
      set({ recommendations: response.videos });
    } catch (error) {
      console.error('Failed to fetch recommendations:', error);
    }
  },

  fetchTrending: async () => {
    try {
      const response = await api.get<{ videos: Video[] }>('/feed/trending');
      set({ trending: response.videos });
    } catch (error) {
      console.error('Failed to fetch trending:', error);
    }
  },

  searchVideos: async (query, page = 1) => {
    set({ isLoading: true, error: null, searchQuery: query });
    try {
      const response = await api.get<SearchResponse>(
        `/feed/search?q=${encodeURIComponent(query)}&page=${page}`
      );

      set({
        searchResults: response.videos || [],
        pagination: response.pagination,
        isLoading: false,
      });
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : 'Search failed',
        isLoading: false,
      });
    }
  },

  clearSearch: () => {
    set({ searchResults: [], searchQuery: '', pagination: null });
  },

  updateVideo: async (videoId, updates) => {
    try {
      const updated = await api.patch<Video>(`/videos/${videoId}`, updates);
      set((state) => ({
        currentVideo: state.currentVideo?.id === videoId ? updated : state.currentVideo,
        videos: state.videos.map((v) => (v.id === videoId ? updated : v)),
      }));
    } catch (error) {
      throw error;
    }
  },

  deleteVideo: async (videoId) => {
    try {
      await api.delete(`/videos/${videoId}`);
      set((state) => ({
        videos: state.videos.filter((v) => v.id !== videoId),
        currentVideo: state.currentVideo?.id === videoId ? null : state.currentVideo,
      }));
      return true;
    } catch {
      return false;
    }
  },

  reactToVideo: async (videoId, reaction) => {
    try {
      await api.post(`/videos/${videoId}/react`, { reaction });

      const current = get().currentVideo;
      if (current && current.id === videoId) {
        const wasLiked = current.userReaction === 'like';
        const wasDisliked = current.userReaction === 'dislike';
        const isRemovingReaction = current.userReaction === reaction;

        set({
          currentVideo: {
            ...current,
            userReaction: isRemovingReaction ? null : reaction,
            likeCount: current.likeCount +
              (reaction === 'like' ? (isRemovingReaction ? -1 : 1) : 0) +
              (wasLiked && reaction === 'dislike' ? -1 : 0),
            dislikeCount: current.dislikeCount +
              (reaction === 'dislike' ? (isRemovingReaction ? -1 : 1) : 0) +
              (wasDisliked && reaction === 'like' ? -1 : 0),
          },
        });
      }
    } catch (error) {
      console.error('Failed to react to video:', error);
    }
  },

  recordView: async (videoId) => {
    try {
      await api.post(`/videos/${videoId}/view`, { watchDuration: 0, watchPercentage: 0 });
    } catch (error) {
      console.error('Failed to record view:', error);
    }
  },
}));
