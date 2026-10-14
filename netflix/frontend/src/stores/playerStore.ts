/**
 * Video Player Store
 *
 * Global state for video playback using Zustand.
 * Manages playback state, quality selection, volume, and progress tracking.
 */
import { create } from 'zustand';
import { streamService } from '../services/streaming';
import type { StreamManifest, StreamQuality } from '../types';

/**
 * Player state interface.
 * Contains all playback-related state and control actions.
 */
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
  /** Another device took this account's last stream slot while we were idle. */
  leaseLost: boolean;

  // For series
  videoId: string | null;
  episodeId: string | null;

  // Actions
  /** Starts a playback session (entitlement + stream slot) and loads its manifest */
  loadManifest: (videoId: string, episodeId?: string) => Promise<void>;
  /** Changes video quality level */
  setQuality: (quality: StreamQuality) => void;
  /** Sets play/pause state */
  setPlaying: (playing: boolean) => void;
  /** Sets volume level (0-1) */
  setVolume: (volume: number) => void;
  /** Toggles mute state */
  toggleMute: () => void;
  /** Updates current playback time */
  setCurrentTime: (time: number) => void;
  /** Sets total video duration */
  setDuration: (duration: number) => void;
  /** Sets buffered amount */
  setBuffered: (buffered: number) => void;
  /** Sets fullscreen state */
  setFullscreen: (fullscreen: boolean) => void;
  /** Shows/hides player controls */
  setShowControls: (show: boolean) => void;
  /** Saves current progress; `final` (exit/unload) uses keepalive and skips the heartbeat */
  saveProgress: (options?: { final?: boolean }) => Promise<void>;
  /** Flushes progress, frees the stream slot, and resets player to initial state */
  reset: () => void;
}

/**
 * Player store hook.
 * Use this hook to access playback state and controls in components.
 */
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
  leaseLost: false,
  videoId: null,
  episodeId: null,

  loadManifest: async (videoId, episodeId) => {
    set({ isLoading: true, error: null, leaseLost: false, videoId, episodeId });
    try {
      const manifest = await streamService.startSession(videoId, episodeId);
      // The player may have been closed while the session was being created.
      if (get().videoId !== videoId || get().episodeId !== episodeId) {
        streamService.endSession(manifest.playbackSessionId).catch(() => undefined);
        return;
      }
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

  saveProgress: async (options) => {
    // Read everything synchronously: reset() calls this right before clearing state.
    const { videoId, episodeId, currentTime, duration, manifest } = get();
    if (!videoId || !manifest || currentTime === 0) return;

    // Some containers report Infinity until fully buffered; fall back to the catalog duration.
    const durationSeconds = Number.isFinite(duration) && duration > 0 ? duration : manifest.durationSeconds;
    const final = options?.final === true;

    try {
      const result = await streamService.updateProgress(
        videoId,
        {
          episodeId: episodeId || undefined,
          positionSeconds: Math.floor(currentTime),
          durationSeconds: Math.floor(durationSeconds),
          clientTimestamp: Date.now(),
          // The exit save must not renew the slot it is about to release.
          playbackSessionId: final ? undefined : manifest.playbackSessionId,
        },
        { keepalive: final }
      );
      if (!final && result.lease && !result.lease.active && get().manifest === manifest) {
        set({ leaseLost: true, isPlaying: false });
      }
    } catch (error) {
      console.error('Failed to save progress:', error);
    }
  },

  reset: () => {
    const { manifest } = get();
    if (manifest) {
      void get().saveProgress({ final: true });
      streamService.endSession(manifest.playbackSessionId).catch(() => undefined);
    }
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
      leaseLost: false,
      videoId: null,
      episodeId: null,
    });
  },
}));
