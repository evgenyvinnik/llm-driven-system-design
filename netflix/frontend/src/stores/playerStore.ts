import { create } from 'zustand';
import { streamService } from '../services/streaming';
import type { StreamManifest, StreamQuality } from '../types';

interface PlayerState {
  isPlaying: boolean;
  manifest: StreamManifest | null;
  currentQuality: StreamQuality | null;
  volume: number;
  isMuted: boolean;
  currentTime: number;
  duration: number;
  buffered: number;
  isFullscreen: boolean;
  showControls: boolean;
  isLoading: boolean;
  error: string | null;

  // For series
  videoId: string | null;
  episodeId: string | null;

  // Actions
  loadManifest: (videoId: string, episodeId?: string) => Promise<void>;
  setQuality: (quality: StreamQuality) => void;
  setPlaying: (playing: boolean) => void;
  setVolume: (volume: number) => void;
  toggleMute: () => void;
  setCurrentTime: (time: number) => void;
  setDuration: (duration: number) => void;
  setBuffered: (buffered: number) => void;
  setFullscreen: (fullscreen: boolean) => void;
  setShowControls: (show: boolean) => void;
  saveProgress: () => Promise<void>;
  reset: () => void;
}

export const usePlayerStore = create<PlayerState>((set, get) => ({
  isPlaying: false,
  manifest: null,
  currentQuality: null,
  volume: 1,
  isMuted: false,
  currentTime: 0,
  duration: 0,
  buffered: 0,
  isFullscreen: false,
  showControls: true,
  isLoading: false,
  error: null,
  videoId: null,
  episodeId: null,

  loadManifest: async (videoId, episodeId) => {
    set({ isLoading: true, error: null, videoId, episodeId });
    try {
      const manifest = await streamService.getManifest(videoId, episodeId);
      const defaultQuality = manifest.qualities.find((q) => q.quality === '720p') ||
                            manifest.qualities[0];

      set({
        manifest,
        currentQuality: defaultQuality,
        duration: manifest.durationSeconds,
        currentTime: manifest.resumePosition || 0,
        isLoading: false,
      });
    } catch (error) {
      set({ error: (error as Error).message, isLoading: false });
    }
  },

  setQuality: (quality) => {
    set({ currentQuality: quality });
  },

  setPlaying: (playing) => {
    set({ isPlaying: playing });
  },

  setVolume: (volume) => {
    set({ volume, isMuted: volume === 0 });
  },

  toggleMute: () => {
    set((state) => ({ isMuted: !state.isMuted }));
  },

  setCurrentTime: (time) => {
    set({ currentTime: time });
  },

  setDuration: (duration) => {
    set({ duration });
  },

  setBuffered: (buffered) => {
    set({ buffered });
  },

  setFullscreen: (fullscreen) => {
    set({ isFullscreen: fullscreen });
  },

  setShowControls: (show) => {
    set({ showControls: show });
  },

  saveProgress: async () => {
    const { videoId, episodeId, currentTime, duration } = get();
    if (!videoId || currentTime === 0) return;

    try {
      await streamService.updateProgress(videoId, {
        episodeId: episodeId || undefined,
        positionSeconds: Math.floor(currentTime),
        durationSeconds: Math.floor(duration),
      });
    } catch (error) {
      console.error('Failed to save progress:', error);
    }
  },

  reset: () => {
    set({
      isPlaying: false,
      manifest: null,
      currentQuality: null,
      currentTime: 0,
      duration: 0,
      buffered: 0,
      isFullscreen: false,
      showControls: true,
      isLoading: false,
      error: null,
      videoId: null,
      episodeId: null,
    });
  },
}));
