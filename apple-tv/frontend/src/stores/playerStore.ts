import { create } from 'zustand';
import type { Content, EncodedVariant } from '../types';
import { streamingApi, watchProgressApi } from '../services/api';

interface PlayerState {
  content: Content | null;
  manifestUrl: string | null;
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  volume: number;
  isMuted: boolean;
  isFullscreen: boolean;
  selectedVariant: EncodedVariant | null;
  selectedAudioTrack: string | null;
  selectedSubtitle: string | null;
  isLoading: boolean;
  error: string | null;

  loadContent: (contentId: string) => Promise<void>;
  play: () => void;
  pause: () => void;
  togglePlay: () => void;
  seek: (time: number) => void;
  setVolume: (volume: number) => void;
  toggleMute: () => void;
  setFullscreen: (fullscreen: boolean) => void;
  updateTime: (time: number) => void;
  setDuration: (duration: number) => void;
  selectVariant: (variant: EncodedVariant) => void;
  selectAudioTrack: (trackId: string) => void;
  selectSubtitle: (subtitleId: string | null) => void;
  saveProgress: () => Promise<void>;
  reset: () => void;
}

export const usePlayerStore = create<PlayerState>()((set, get) => ({
  content: null,
  manifestUrl: null,
  isPlaying: false,
  currentTime: 0,
  duration: 0,
  volume: 1,
  isMuted: false,
  isFullscreen: false,
  selectedVariant: null,
  selectedAudioTrack: null,
  selectedSubtitle: null,
  isLoading: false,
  error: null,

  loadContent: async (contentId: string) => {
    set({ isLoading: true, error: null });
    try {
      const playbackInfo = await streamingApi.getPlaybackInfo(contentId);

      // Get saved progress
      const progress = await watchProgressApi.getContentProgress(contentId);

      set({
        content: playbackInfo.content,
        manifestUrl: playbackInfo.manifestUrl,
        currentTime: progress.position || 0,
        duration: playbackInfo.content.duration,
        isLoading: false,
      });
    } catch (error) {
      set({ error: (error as Error).message, isLoading: false });
      throw error;
    }
  },

  play: () => set({ isPlaying: true }),
  pause: () => set({ isPlaying: false }),
  togglePlay: () => set((state) => ({ isPlaying: !state.isPlaying })),

  seek: (time: number) => {
    const { duration } = get();
    const clampedTime = Math.max(0, Math.min(time, duration));
    set({ currentTime: clampedTime });
  },

  setVolume: (volume: number) => {
    const clampedVolume = Math.max(0, Math.min(1, volume));
    set({ volume: clampedVolume, isMuted: clampedVolume === 0 });
  },

  toggleMute: () => set((state) => ({ isMuted: !state.isMuted })),

  setFullscreen: (fullscreen: boolean) => set({ isFullscreen: fullscreen }),

  updateTime: (time: number) => set({ currentTime: time }),

  setDuration: (duration: number) => set({ duration }),

  selectVariant: (variant: EncodedVariant) => set({ selectedVariant: variant }),

  selectAudioTrack: (trackId: string) => set({ selectedAudioTrack: trackId }),

  selectSubtitle: (subtitleId: string | null) => set({ selectedSubtitle: subtitleId }),

  saveProgress: async () => {
    const { content, currentTime, duration } = get();
    if (content && currentTime > 0) {
      try {
        await watchProgressApi.updateProgress(content.id, Math.floor(currentTime), duration);
      } catch (error) {
        console.error('Failed to save progress:', error);
      }
    }
  },

  reset: () =>
    set({
      content: null,
      manifestUrl: null,
      isPlaying: false,
      currentTime: 0,
      duration: 0,
      selectedVariant: null,
      selectedAudioTrack: null,
      selectedSubtitle: null,
      isLoading: false,
      error: null,
    }),
}));
