import { create } from 'zustand';
import type { Match, Message } from '../types';
import { matchApi } from '../services/api';
import { wsService } from '../services/websocket';

interface MatchState {
  matches: Match[];
  currentMatchId: string | null;
  messages: Message[];
  isLoading: boolean;
  error: string | null;
  unreadCount: number;

  loadMatches: () => Promise<void>;
  loadMessages: (matchId: string) => Promise<void>;
  sendMessage: (content: string) => Promise<void>;
  unmatch: (matchId: string) => Promise<void>;
  setCurrentMatch: (matchId: string | null) => void;
  addMessage: (message: Message) => void;
  loadUnreadCount: () => Promise<void>;
  subscribeToMessages: () => () => void;
}

export const useMatchStore = create<MatchState>((set, get) => ({
  matches: [],
  currentMatchId: null,
  messages: [],
  isLoading: false,
  error: null,
  unreadCount: 0,

  loadMatches: async () => {
    set({ isLoading: true, error: null });
    try {
      const matches = await matchApi.getMatches();
      set({ matches, isLoading: false });
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : 'Failed to load matches',
        isLoading: false,
      });
    }
  },

  loadMessages: async (matchId) => {
    set({ isLoading: true, error: null, currentMatchId: matchId });
    try {
      const messages = await matchApi.getMessages(matchId);
      set({ messages: messages.reverse(), isLoading: false });

      // Mark as read
      await matchApi.markAsRead(matchId);

      // Update unread count for this match
      const matches = get().matches.map((m) =>
        m.id === matchId ? { ...m, unread_count: 0 } : m
      );
      set({ matches });
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : 'Failed to load messages',
        isLoading: false,
      });
    }
  },

  sendMessage: async (content) => {
    const { currentMatchId } = get();
    if (!currentMatchId) return;

    try {
      const message = await matchApi.sendMessage(currentMatchId, content);
      const messages = [...get().messages, { ...message, is_mine: true }];
      set({ messages });

      // Update match's last message
      const matches = get().matches.map((m) =>
        m.id === currentMatchId
          ? {
              ...m,
              last_message_at: message.sent_at,
              last_message_preview: content.substring(0, 50),
            }
          : m
      );
      set({ matches });
    } catch (error) {
      throw error;
    }
  },

  unmatch: async (matchId) => {
    try {
      await matchApi.unmatch(matchId);
      const matches = get().matches.filter((m) => m.id !== matchId);
      set({ matches, currentMatchId: null, messages: [] });
    } catch (error) {
      throw error;
    }
  },

  setCurrentMatch: (matchId) => {
    set({ currentMatchId: matchId, messages: [] });
  },

  addMessage: (message) => {
    const { currentMatchId, messages, matches } = get();

    if (currentMatchId && message.sender_id) {
      // Add to current messages if viewing this conversation
      set({ messages: [...messages, message] });
    }

    // Update match list
    const updatedMatches = matches.map((m) => {
      if (m.id === currentMatchId) {
        return {
          ...m,
          last_message_at: message.sent_at,
          last_message_preview: message.content?.substring(0, 50),
          unread_count: currentMatchId ? 0 : m.unread_count + 1,
        };
      }
      return m;
    });
    set({ matches: updatedMatches });
  },

  loadUnreadCount: async () => {
    try {
      const { count } = await matchApi.getUnreadCount();
      set({ unreadCount: count });
    } catch {
      // Ignore errors
    }
  },

  subscribeToMessages: () => {
    const unsubscribe = wsService.on('new_message', (data) => {
      const message = data.message as Message;
      get().addMessage(message);
      get().loadUnreadCount();
    });

    const unsubscribeMatch = wsService.on('new_match', () => {
      get().loadMatches();
    });

    return () => {
      unsubscribe();
      unsubscribeMatch();
    };
  },
}));
