import { create } from 'zustand';
import type { Track, RepeatMode } from '../types';
import { playbackApi } from '../services/api';

interface PlayerState {
  // Current track state
  currentTrack: Track | null;
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  volume: number;
  isMuted: boolean;

  // Queue
  queue: Track[];
  queueIndex: number;
  originalQueue: Track[];

  // Playback modes
  shuffleEnabled: boolean;
  repeatMode: RepeatMode;

  // Audio element reference
  audioRef: HTMLAudioElement | null;
  streamUrl: string | null;
  streamCountRecorded: boolean;

  // Actions
  setAudioRef: (ref: HTMLAudioElement) => void;
  playTrack: (track: Track, queue?: Track[]) => Promise<void>;
  playQueue: (tracks: Track[], startIndex?: number) => void;
  togglePlay: () => void;
  pause: () => void;
  play: () => void;
  next: () => void;
  previous: () => void;
  seek: (time: number) => void;
  setVolume: (volume: number) => void;
  toggleMute: () => void;
  toggleShuffle: () => void;
  cycleRepeat: () => void;
  addToQueue: (track: Track) => void;
  clearQueue: () => void;

  // Internal updates
  setCurrentTime: (time: number) => void;
  setDuration: (duration: number) => void;
  onTrackEnd: () => void;
}

function shuffleArray<T>(array: T[]): T[] {
  const shuffled = [...array];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

export const usePlayerStore = create<PlayerState>((set, get) => ({
  currentTrack: null,
  isPlaying: false,
  currentTime: 0,
  duration: 0,
  volume: 0.8,
  isMuted: false,

  queue: [],
  queueIndex: 0,
  originalQueue: [],

  shuffleEnabled: false,
  repeatMode: 'off',

  audioRef: null,
  streamUrl: null,
  streamCountRecorded: false,

  setAudioRef: (ref) => set({ audioRef: ref }),

  playTrack: async (track, queue) => {
    const { audioRef } = get();

    try {
      // Get stream URL
      const { url } = await playbackApi.getStreamUrl(track.id);

      // Record play started event
      playbackApi.recordEvent(track.id, 'play_started').catch(console.error);

      // Set up queue if provided
      if (queue && queue.length > 0) {
        const index = queue.findIndex(t => t.id === track.id);
        set({
          queue,
          originalQueue: queue,
          queueIndex: index >= 0 ? index : 0,
        });
      }

      set({
        currentTrack: track,
        streamUrl: url,
        isPlaying: true,
        currentTime: 0,
        streamCountRecorded: false,
      });

      if (audioRef) {
        audioRef.src = url;
        audioRef.play().catch(console.error);
      }
    } catch (error) {
      console.error('Failed to play track:', error);
    }
  },

  playQueue: (tracks, startIndex = 0) => {
    if (tracks.length === 0) return;

    const { shuffleEnabled } = get();
    const queue = shuffleEnabled ? shuffleArray(tracks) : tracks;
    const track = queue[startIndex];

    if (track) {
      set({
        queue,
        originalQueue: tracks,
        queueIndex: startIndex,
      });
      get().playTrack(track, queue);
    }
  },

  togglePlay: () => {
    const { audioRef, isPlaying, currentTrack } = get();
    if (!audioRef || !currentTrack) return;

    if (isPlaying) {
      audioRef.pause();
      playbackApi.recordEvent(currentTrack.id, 'play_paused', audioRef.currentTime * 1000).catch(console.error);
    } else {
      audioRef.play().catch(console.error);
      playbackApi.recordEvent(currentTrack.id, 'play_resumed', audioRef.currentTime * 1000).catch(console.error);
    }
    set({ isPlaying: !isPlaying });
  },

  pause: () => {
    const { audioRef, currentTrack } = get();
    if (audioRef) {
      audioRef.pause();
      if (currentTrack) {
        playbackApi.recordEvent(currentTrack.id, 'play_paused', audioRef.currentTime * 1000).catch(console.error);
      }
    }
    set({ isPlaying: false });
  },

  play: () => {
    const { audioRef, currentTrack } = get();
    if (audioRef) {
      audioRef.play().catch(console.error);
      if (currentTrack) {
        playbackApi.recordEvent(currentTrack.id, 'play_resumed', audioRef.currentTime * 1000).catch(console.error);
      }
    }
    set({ isPlaying: true });
  },

  next: () => {
    const { queue, queueIndex, repeatMode, currentTrack, audioRef } = get();

    // Record skip event
    if (currentTrack && audioRef) {
      playbackApi.recordEvent(currentTrack.id, 'skipped', audioRef.currentTime * 1000).catch(console.error);
    }

    if (queue.length === 0) return;

    let nextIndex = queueIndex + 1;

    if (nextIndex >= queue.length) {
      if (repeatMode === 'all') {
        nextIndex = 0;
      } else {
        set({ isPlaying: false });
        return;
      }
    }

    const nextTrack = queue[nextIndex];
    if (nextTrack) {
      set({ queueIndex: nextIndex });
      get().playTrack(nextTrack);
    }
  },

  previous: () => {
    const { queue, queueIndex, audioRef, currentTime } = get();

    // If more than 3 seconds in, restart current track
    if (currentTime > 3 && audioRef) {
      audioRef.currentTime = 0;
      return;
    }

    if (queue.length === 0 || queueIndex === 0) {
      if (audioRef) audioRef.currentTime = 0;
      return;
    }

    const prevIndex = queueIndex - 1;
    const prevTrack = queue[prevIndex];
    if (prevTrack) {
      set({ queueIndex: prevIndex });
      get().playTrack(prevTrack);
    }
  },

  seek: (time) => {
    const { audioRef, currentTrack } = get();
    if (audioRef) {
      audioRef.currentTime = time;
      if (currentTrack) {
        playbackApi.recordEvent(currentTrack.id, 'seeked', time * 1000).catch(console.error);
      }
    }
    set({ currentTime: time });
  },

  setVolume: (volume) => {
    const { audioRef } = get();
    if (audioRef) {
      audioRef.volume = volume;
    }
    set({ volume, isMuted: volume === 0 });
  },

  toggleMute: () => {
    const { audioRef, isMuted, volume } = get();
    if (audioRef) {
      audioRef.volume = isMuted ? volume : 0;
    }
    set({ isMuted: !isMuted });
  },

  toggleShuffle: () => {
    const { shuffleEnabled, originalQueue, currentTrack, queueIndex } = get();

    if (shuffleEnabled) {
      // Turn off shuffle - restore original order
      const currentTrackIndex = originalQueue.findIndex(t => t.id === currentTrack?.id);
      set({
        shuffleEnabled: false,
        queue: originalQueue,
        queueIndex: currentTrackIndex >= 0 ? currentTrackIndex : queueIndex,
      });
    } else {
      // Turn on shuffle
      const remaining = originalQueue.filter(t => t.id !== currentTrack?.id);
      const shuffled = currentTrack
        ? [currentTrack, ...shuffleArray(remaining)]
        : shuffleArray(originalQueue);
      set({
        shuffleEnabled: true,
        queue: shuffled,
        queueIndex: 0,
      });
    }
  },

  cycleRepeat: () => {
    const { repeatMode } = get();
    const modes: RepeatMode[] = ['off', 'all', 'one'];
    const currentIndex = modes.indexOf(repeatMode);
    const nextMode = modes[(currentIndex + 1) % modes.length];
    set({ repeatMode: nextMode });
  },

  addToQueue: (track) => {
    const { queue, queueIndex } = get();
    const newQueue = [...queue];
    newQueue.splice(queueIndex + 1, 0, track);
    set({ queue: newQueue });
  },

  clearQueue: () => {
    set({
      queue: [],
      originalQueue: [],
      queueIndex: 0,
      currentTrack: null,
      isPlaying: false,
      streamUrl: null,
    });
  },

  setCurrentTime: (time) => {
    const { currentTrack, streamCountRecorded } = get();

    // Record stream count after 30 seconds
    if (currentTrack && !streamCountRecorded && time >= 30) {
      playbackApi.recordEvent(currentTrack.id, 'stream_counted', time * 1000).catch(console.error);
      set({ streamCountRecorded: true });
    }

    set({ currentTime: time });
  },

  setDuration: (duration) => set({ duration }),

  onTrackEnd: () => {
    const { repeatMode, currentTrack, audioRef } = get();

    // Record play completed event
    if (currentTrack && audioRef) {
      playbackApi.recordEvent(currentTrack.id, 'play_completed', audioRef.duration * 1000).catch(console.error);
    }

    if (repeatMode === 'one' && audioRef) {
      audioRef.currentTime = 0;
      audioRef.play().catch(console.error);
      set({ streamCountRecorded: false });
    } else {
      get().next();
    }
  },
}));
