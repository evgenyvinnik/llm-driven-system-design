import { create } from 'zustand';
import { Comment, ReactionCount, Stream, User } from '../types';

interface AppState {
  // Current user
  currentUser: User | null;
  setCurrentUser: (user: User | null) => void;

  // Streams
  streams: Stream[];
  currentStream: Stream | null;
  setStreams: (streams: Stream[]) => void;
  setCurrentStream: (stream: Stream | null) => void;

  // Comments
  comments: Comment[];
  addComments: (comments: Comment[]) => void;
  clearComments: () => void;

  // Reactions
  reactionCounts: ReactionCount;
  addReactionCounts: (counts: ReactionCount) => void;

  // Viewer count
  viewerCount: number;
  setViewerCount: (count: number) => void;

  // Connection state
  isConnected: boolean;
  setIsConnected: (connected: boolean) => void;

  // Floating reactions (for animation)
  floatingReactions: Array<{ id: string; type: string }>;
  addFloatingReaction: (type: string) => void;
  removeFloatingReaction: (id: string) => void;
}

export const useAppStore = create<AppState>((set) => ({
  // Current user
  currentUser: null,
  setCurrentUser: (user) => set({ currentUser: user }),

  // Streams
  streams: [],
  currentStream: null,
  setStreams: (streams) => set({ streams }),
  setCurrentStream: (stream) => set({ currentStream: stream }),

  // Comments - append new comments, limit to 200 for performance
  comments: [],
  addComments: (newComments) =>
    set((state) => {
      const allComments = [...state.comments, ...newComments];
      // Keep only the last 200 comments for performance
      return { comments: allComments.slice(-200) };
    }),
  clearComments: () => set({ comments: [] }),

  // Reactions
  reactionCounts: {},
  addReactionCounts: (newCounts) =>
    set((state) => {
      const updated = { ...state.reactionCounts };
      for (const [type, count] of Object.entries(newCounts)) {
        updated[type] = (updated[type] || 0) + count;
      }
      return { reactionCounts: updated };
    }),

  // Viewer count
  viewerCount: 0,
  setViewerCount: (count) => set({ viewerCount: count }),

  // Connection state
  isConnected: false,
  setIsConnected: (connected) => set({ isConnected: connected }),

  // Floating reactions
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
