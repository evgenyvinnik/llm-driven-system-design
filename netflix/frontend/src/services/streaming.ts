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

/** Response to a progress report (which doubles as the stream-slot heartbeat). */
interface ProgressReportResponse {
  success: boolean;
  applied: boolean;
  completed: boolean;
  lease?: { active: boolean; activeStreams: number; limit: number };
}

/** A progress report. `clientTimestamp` orders reports (last writer wins). */
export interface ProgressReport {
  episodeId?: string;
  positionSeconds: number;
  durationSeconds: number;
  clientTimestamp: number;
  playbackSessionId?: string;
}

/**
 * Streaming service for video playback.
 */
export const streamService = {
  /**
   * Starts a playback session. The server checks maturity, plan and the
   * concurrent-stream limit, and returns rendition URLs signed for this session
   * plus the resume position. 403 = not allowed on this profile, 409 = too many
   * screens in use.
   */
  startSession: async (videoId: string, episodeId?: string): Promise<StreamManifest> => {
    return api.post<StreamManifest>(`/stream/${videoId}/sessions`, episodeId ? { episodeId } : {});
  },

  /**
   * Reports the playback position. Sent every 10 s while playing (with the
   * session id, renewing the stream slot), on pause, and on exit (keepalive).
   */
  updateProgress: async (
    videoId: string,
    report: ProgressReport,
    options?: { keepalive?: boolean }
  ): Promise<ProgressReportResponse> => {
    return api.post<ProgressReportResponse>(`/stream/${videoId}/progress`, report, options);
  },

  /** Ends a playback session, freeing its stream slot. Survives page unload. */
  endSession: async (playbackSessionId: string): Promise<void> => {
    await api.del<void>(`/stream/sessions/${playbackSessionId}`, { keepalive: true });
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
};
