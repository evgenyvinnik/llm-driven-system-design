import { api } from './api';
import type { StreamManifest } from '../types';

interface ProgressResponse {
  positionSeconds: number;
  durationSeconds: number;
  percentComplete: number;
  completed: boolean;
}

export const streamService = {
  getManifest: async (
    videoId: string,
    episodeId?: string
  ): Promise<StreamManifest> => {
    const params = episodeId ? `?episodeId=${episodeId}` : '';
    return api.get<StreamManifest>(`/stream/${videoId}/manifest${params}`);
  },

  updateProgress: async (
    videoId: string,
    data: {
      episodeId?: string;
      positionSeconds: number;
      durationSeconds: number;
    }
  ): Promise<{ success: boolean; completed: boolean }> => {
    return api.post<{ success: boolean; completed: boolean }>(
      `/stream/${videoId}/progress`,
      data
    );
  },

  getProgress: async (
    videoId: string,
    episodeId?: string
  ): Promise<ProgressResponse> => {
    const params = episodeId ? `?episodeId=${episodeId}` : '';
    return api.get<ProgressResponse>(`/stream/${videoId}/progress${params}`);
  },

  // Get video stream URL (for direct playback)
  getStreamUrl: (videoId: string, quality: string, episodeId?: string): string => {
    const params = new URLSearchParams({ quality });
    if (episodeId) params.set('episodeId', episodeId);
    return `/api/stream/${videoId}/play?${params.toString()}`;
  },
};
