/**
 * App Store Module
 *
 * Global state management using Zustand. Contains all application state
 * including user session, stream data, comments, reactions, and UI state.
 * Provides actions for state updates that are triggered by WebSocket events
 * and user interactions.
 *
 * @module stores/appStore
 */

import { create } from 'zustand';
import { Comment, ReactionCount, Stream, User } from '../types';

/**
 * Application state interface.
 * Defines all global state and actions available in the store.
 */
interface AppState {
  /** Currently logged-in user (selected in demo) */
  currentUser: User | null;
  /** Sets the current user */
  setCurrentUser: (user: User | null) => void;

  /** List of all available streams */
  streams: Stream[];
  /** Currently selected stream being watched */
  currentStream: Stream | null;
  /** Sets the list of streams */
  setStreams: (streams: Stream[]) => void;
  /** Sets the current stream */
  setCurrentStream: (stream: Stream | null) => void;

  /** Comments for the current stream (limited to 200 for performance) */
  comments: Comment[];
  /** Appends new comments to the list */
  addComments: (comments: Comment[]) => void;
  /** Clears all comments (called when switching streams) */
  clearComments: () => void;

  /** Aggregated reaction counts for the current stream */
  reactionCounts: ReactionCount;
  /** Adds to reaction counts (merges with existing) */
  addReactionCounts: (counts: ReactionCount) => void;

  /** Current viewer count for the stream */
  viewerCount: number;
  /** Updates the viewer count */
  setViewerCount: (count: number) => void;

  /** WebSocket connection status */
  isConnected: boolean;
  /** Updates connection status */
  setIsConnected: (connected: boolean) => void;

  /** Floating reaction animations (temporary visual elements) */
  floatingReactions: Array<{ id: string; type: string }>;
  /** Adds a floating reaction for animation */
  addFloatingReaction: (type: string) => void;
  /** Removes a floating reaction after animation completes */
  removeFloatingReaction: (id: string) => void;
}

/**
 * Global application store.
 * Use with `useAppStore((state) => state.field)` for selective subscriptions.
 */
export const useAppStore = create<AppState>((set) => ({
  // Current user state
  currentUser: null,
  setCurrentUser: (user) => set({ currentUser: user }),

  // Stream state
  streams: [],
  currentStream: null,
  setStreams: (streams) => set({ streams }),
  setCurrentStream: (stream) => set({ currentStream: stream }),

  // Comments - append new and limit to 200 for performance
  comments: [],
  addComments: (newComments) =>
    set((state) => {
      const allComments = [...state.comments, ...newComments];
      return { comments: allComments.slice(-200) };
    }),
  clearComments: () => set({ comments: [] }),

  // Reaction counts - merge incoming with existing
  reactionCounts: {},
  addReactionCounts: (newCounts) =>
    set((state) => {
      const updated = { ...state.reactionCounts };
      for (const [type, count] of Object.entries(newCounts)) {
        updated[type] = (updated[type] || 0) + count;
      }
      return { reactionCounts: updated };
    }),

  // Viewer count from WebSocket
  viewerCount: 0,
  setViewerCount: (count) => set({ viewerCount: count }),

  // WebSocket connection status
  isConnected: false,
  setIsConnected: (connected) => set({ isConnected: connected }),

  // Floating reactions for visual feedback
  floatingReactions: [],
  addFloatingReaction: (type) =>
    set((state) => ({
      floatingReactions: [
        ...state.floatingReactions,
        { id: `${Date.now()}-${Math.random()}`, type },
      ],
    })),
  removeFloatingReaction: (id) =>
    set((state) => ({
      floatingReactions: state.floatingReactions.filter((r) => r.id !== id),
    })),
}));
