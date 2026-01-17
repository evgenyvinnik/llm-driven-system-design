import { create } from 'zustand';
import { Track } from '../types';
import { streamApi, libraryApi } from '../services/api';

export type RepeatMode = 'off' | 'all' | 'one';

interface PlayerState {
  currentTrack: Track | null;
  queue: Track[];
  queueIndex: number;
  isPlaying: boolean;
  volume: number;
  isMuted: boolean;
  progress: number;
  duration: number;
  isShuffled: boolean;
  repeatMode: RepeatMode;
  audioElement: HTMLAudioElement | null;
  isLoading: boolean;
  error: string | null;

  // Actions
  setAudioElement: (element: HTMLAudioElement) => void;
  playTrack: (track: Track, queue?: Track[], index?: number) => Promise<void>;
  playQueue: (tracks: Track[], startIndex?: number) => Promise<void>;
  togglePlay: () => void;
  pause: () => void;
  resume: () => void;
  next: () => Promise<void>;
  previous: () => Promise<void>;
  seekTo: (time: number) => void;
  setVolume: (volume: number) => void;
  toggleMute: () => void;
  toggleShuffle: () => void;
  setRepeatMode: (mode: RepeatMode) => void;
  addToQueue: (track: Track) => void;
  removeFromQueue: (index: number) => void;
  clearQueue: () => void;
  updateProgress: (time: number, duration: number) => void;
}

export const usePlayerStore = create<PlayerState>((set, get) => ({
  currentTrack: null,
  queue: [],
  queueIndex: -1,
  isPlaying: false,
  volume: 1,
  isMuted: false,
  progress: 0,
  duration: 0,
  isShuffled: false,
  repeatMode: 'off',
  audioElement: null,
  isLoading: false,
  error: null,

  setAudioElement: (element) => set({ audioElement: element }),

  playTrack: async (track, queue, index) => {
    const state = get();
    set({ isLoading: true, error: null });

    try {
      // Get stream URL
      const { stream } = await streamApi.getStreamUrl(track.id);

      // Set up queue if provided
      if (queue && queue.length > 0) {
        set({
          queue,
          queueIndex: index ?? 0,
        });
      } else if (!queue) {
        set({
          queue: [track],
          queueIndex: 0,
        });
      }

      set({
        currentTrack: track,
        isLoading: false,
      });

      // Play the audio
      if (state.audioElement) {
        state.audioElement.src = stream.url;
        state.audioElement.load();
        await state.audioElement.play();
        set({ isPlaying: true });
      }

      // Record play after 30 seconds
      setTimeout(() => {
        const currentState = get();
        if (currentState.currentTrack?.id === track.id && currentState.progress > 30000) {
          libraryApi.recordPlay(track.id, currentState.progress, 'library', undefined, true).catch(() => {});
        }
      }, 30000);
    } catch (error) {
      set({ error: (error as Error).message, isLoading: false });
    }
  },

  playQueue: async (tracks, startIndex = 0) => {
    if (tracks.length === 0) return;

    set({
      queue: tracks,
      queueIndex: startIndex,
    });

    await get().playTrack(tracks[startIndex], tracks, startIndex);
  },

  togglePlay: () => {
    const { audioElement, isPlaying } = get();
    if (!audioElement) return;

    if (isPlaying) {
      audioElement.pause();
      set({ isPlaying: false });
    } else {
      audioElement.play();
      set({ isPlaying: true });
    }
  },

  pause: () => {
    const { audioElement } = get();
    if (audioElement) {
      audioElement.pause();
      set({ isPlaying: false });
    }
  },

  resume: () => {
    const { audioElement } = get();
    if (audioElement) {
      audioElement.play();
      set({ isPlaying: true });
    }
  },

  next: async () => {
    const { queue, queueIndex, repeatMode, isShuffled } = get();

    if (queue.length === 0) return;

    let nextIndex: number;

    if (repeatMode === 'one') {
      nextIndex = queueIndex;
    } else if (isShuffled) {
      nextIndex = Math.floor(Math.random() * queue.length);
    } else if (queueIndex < queue.length - 1) {
      nextIndex = queueIndex + 1;
    } else if (repeatMode === 'all') {
      nextIndex = 0;
    } else {
      // End of queue
      set({ isPlaying: false });
      return;
    }

    set({ queueIndex: nextIndex });
    await get().playTrack(queue[nextIndex], queue, nextIndex);
  },

  previous: async () => {
    const { queue, queueIndex, progress, repeatMode } = get();

    if (queue.length === 0) return;

    // If more than 3 seconds in, restart current track
    if (progress > 3000) {
      get().seekTo(0);
      return;
    }

    let prevIndex: number;

    if (queueIndex > 0) {
      prevIndex = queueIndex - 1;
    } else if (repeatMode === 'all') {
      prevIndex = queue.length - 1;
    } else {
      prevIndex = 0;
    }

    set({ queueIndex: prevIndex });
    await get().playTrack(queue[prevIndex], queue, prevIndex);
  },

  seekTo: (time) => {
    const { audioElement } = get();
    if (audioElement) {
      audioElement.currentTime = time / 1000;
    }
  },

  setVolume: (volume) => {
    const { audioElement } = get();
    if (audioElement) {
      audioElement.volume = volume;
    }
    set({ volume, isMuted: volume === 0 });
  },

  toggleMute: () => {
    const { audioElement, isMuted, volume } = get();
    if (audioElement) {
      if (isMuted) {
        audioElement.volume = volume || 1;
        set({ isMuted: false });
      } else {
        audioElement.volume = 0;
        set({ isMuted: true });
      }
    }
  },

  toggleShuffle: () => {
    set((state) => ({ isShuffled: !state.isShuffled }));
  },

  setRepeatMode: (mode) => set({ repeatMode: mode }),

  addToQueue: (track) => {
    set((state) => ({
      queue: [...state.queue, track],
    }));
  },

  removeFromQueue: (index) => {
    set((state) => {
      const newQueue = [...state.queue];
      newQueue.splice(index, 1);

      let newIndex = state.queueIndex;
      if (index < state.queueIndex) {
        newIndex--;
      } else if (index === state.queueIndex && index >= newQueue.length) {
        newIndex = Math.max(0, newQueue.length - 1);
      }

      return { queue: newQueue, queueIndex: newIndex };
    });
  },

  clearQueue: () => {
    set({ queue: [], queueIndex: -1 });
  },

  updateProgress: (time, duration) => {
    set({ progress: time * 1000, duration: duration * 1000 });
  },
}));
