/**
 * Video Streaming Service
 *
 * Handles video playback including manifest retrieval,
 * progress tracking, and stream URL generation.
 */
import { api } from './api';
import type { StreamManifest } from '../types';

/** Response containing viewing progress data */
interface ProgressResponse {
  positionSeconds: number;
  durationSeconds: number;
  percentComplete: number;
  completed: boolean;
}

/**
 * Streaming service for video playback.
 */
export const streamService = {
  /**
   * Gets streaming manifest with available quality levels and resume position.
   *
   * @param videoId - Video ID to get manifest for
   * @param episodeId - Optional episode ID for series
   * @returns Promise resolving to stream manifest
   */
  getManifest: async (
    videoId: string,
    episodeId?: string
  ): Promise<StreamManifest> => {
    const params = episodeId ? `?episodeId=${episodeId}` : '';
    return api.get<StreamManifest>(`/stream/${videoId}/manifest${params}`);
  },

  /**
   * Updates viewing progress on the server.
   * Called periodically during playback for resume functionality.
   *
   * @param videoId - Video ID being watched
   * @param data - Progress data including position and duration
   * @returns Promise indicating success and completion status
   */
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

  /**
   * Gets current viewing progress for a video or episode.
   *
   * @param videoId - Video ID to get progress for
   * @param episodeId - Optional episode ID for series
   * @returns Promise resolving to progress data
   */
  getProgress: async (
    videoId: string,
    episodeId?: string
  ): Promise<ProgressResponse> => {
    const params = episodeId ? `?episodeId=${episodeId}` : '';
    return api.get<ProgressResponse>(`/stream/${videoId}/progress${params}`);
  },

  /**
   * Generates direct stream URL for video playback.
   * Returns API URL that redirects to presigned storage URL.
   *
   * @param videoId - Video ID to stream
   * @param quality - Quality level (e.g., "720p", "1080p")
   * @param episodeId - Optional episode ID for series
   * @returns Stream URL for video element
   */
  getStreamUrl: (videoId: string, quality: string, episodeId?: string): string => {
    const params = new URLSearchParams({ quality });
    if (episodeId) params.set('episodeId', episodeId);
    return `/api/stream/${videoId}/play?${params.toString()}`;
  },
};
