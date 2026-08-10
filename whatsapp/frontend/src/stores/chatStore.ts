/**
 * Chat Store
 *
 * Manages messaging state using Zustand including:
 * - Conversation list and current selection
 * - Message history per conversation with pagination
 * - Typing indicators and user presence
 * - Pending message tracking for optimistic updates
 * - Message reactions
 */

import { create } from 'zustand';
import { Conversation, Message, MessageStatus, PresenceInfo } from '../types';
import { conversationsApi, messagesApi, reactionsApi, ReactionSummary } from '../services/api';

/**
 * Chat state interface.
 * Centralizes all messaging-related state and actions.
 */
interface ChatState {
  conversations: Conversation[];
  currentConversationId: string | null;
  messages: Record<string, Message[]>; // conversationId -> messages
  typingUsers: Record<string, string[]>; // conversationId -> userIds typing
  userPresence: Record<string, PresenceInfo>; // userId -> presence
  pendingMessages: Map<string, Message>; // clientMessageId -> message
  isLoadingConversations: boolean;
  isLoadingMessages: boolean;
  hasMoreMessages: Record<string, boolean>; // conversationId -> hasMore
  oldestMessageId: Record<string, string | null>; // conversationId -> oldest message id
  messageReactions: Record<string, ReactionSummary[]>; // messageId -> reactions
  isLoadingMoreMessages: boolean;

  // Actions
  loadConversations: () => Promise<void>;
  loadMessages: (conversationId: string) => Promise<void>;
  loadMoreMessages: (conversationId: string) => Promise<void>;
  setCurrentConversation: (conversationId: string | null) => void;
  addMessage: (message: Message) => void;
  updateMessageStatus: (messageId: string, status: MessageStatus) => void;
  updateMessageId: (clientMessageId: string, messageId: string, createdAt: string) => void;
  markMessagesAsRead: (messageIds: string[], conversationId: string) => void;
  setTyping: (conversationId: string, userId: string, isTyping: boolean) => void;
  updatePresence: (userId: string, status: 'online' | 'offline', lastSeen?: number) => void;
  addConversation: (conversation: Conversation) => void;
  updateConversationLastMessage: (conversationId: string, message: Message) => void;
  toggleReaction: (conversationId: string, messageId: string, emoji: string) => Promise<void>;
  updateMessageReactions: (messageId: string, reactions: ReactionSummary[]) => void;
}

/**
 * Zustand store for chat state management.
 * Provides reactive updates for real-time messaging UI.
 */
export const useChatStore = create<ChatState>((set, get) => ({
  conversations: [],
  currentConversationId: null,
  messages: {},
  typingUsers: {},
  userPresence: {},
  pendingMessages: new Map(),
  isLoadingConversations: false,
  isLoadingMessages: false,
  hasMoreMessages: {},
  oldestMessageId: {},
  messageReactions: {},
  isLoadingMoreMessages: false,

  loadConversations: async () => {
    set({ isLoadingConversations: true });
    try {
      const { conversations } = await conversationsApi.list();
      set({ conversations, isLoadingConversations: false });
    } catch (error) {
      console.error('Failed to load conversations:', error);
      set({ isLoadingConversations: false });
    }
  },

  loadMessages: async (conversationId: string) => {
    set({ isLoadingMessages: true });
    try {
      const { messages } = await messagesApi.list(conversationId, 50);
      const oldestId = messages.length > 0 ? messages[0].id : null;

      // Reactions have to be fetched with the thread. `messageReactions` was
      // otherwise only ever written by this client's own add/remove calls and by
      // live WebSocket events, so any reaction added before this session — or
      // before a page reload — was invisible.
      let reactions: Record<string, ReactionSummary[]> = {};
      try {
        ({ reactions } = await reactionsApi.getForConversation(conversationId));
      } catch (error) {
        // A reaction fetch failure must not blank the thread itself.
        console.error('Failed to load reactions:', error);
      }

      set((state) => ({
        messageReactions: {
          ...state.messageReactions,
          ...reactions,
        },
        messages: {
          ...state.messages,
          [conversationId]: messages,
        },
        hasMoreMessages: {
          ...state.hasMoreMessages,
          [conversationId]: messages.length === 50,
        },
        oldestMessageId: {
          ...state.oldestMessageId,
          [conversationId]: oldestId,
        },
        isLoadingMessages: false,
      }));
    } catch (error) {
      console.error('Failed to load messages:', error);
      set({ isLoadingMessages: false });
    }
  },

  loadMoreMessages: async (conversationId: string) => {
    const state = get();
    if (state.isLoadingMoreMessages || !state.hasMoreMessages[conversationId]) {
      return;
    }

    const beforeId = state.oldestMessageId[conversationId];
    if (!beforeId) return;

    set({ isLoadingMoreMessages: true });
    try {
      const { messages: olderMessages } = await messagesApi.list(conversationId, 50, beforeId);
      const newOldestId = olderMessages.length > 0 ? olderMessages[0].id : beforeId;

      set((state) => ({
        messages: {
          ...state.messages,
          [conversationId]: [...olderMessages, ...(state.messages[conversationId] || [])],
        },
        hasMoreMessages: {
          ...state.hasMoreMessages,
          [conversationId]: olderMessages.length === 50,
        },
        oldestMessageId: {
          ...state.oldestMessageId,
          [conversationId]: newOldestId,
        },
        isLoadingMoreMessages: false,
      }));
    } catch (error) {
      console.error('Failed to load more messages:', error);
      set({ isLoadingMoreMessages: false });
    }
  },

  setCurrentConversation: (conversationId: string | null) => {
    set({ currentConversationId: conversationId });
  },

  addMessage: (message: Message) => {
    set((state) => {
      const conversationId = message.conversation_id;
      const existingMessages = state.messages[conversationId] || [];

      // Check for duplicate by id or clientMessageId
      const isDuplicate = existingMessages.some(
        (m) =>
          m.id === message.id ||
          (message.clientMessageId && m.clientMessageId === message.clientMessageId)
      );

      if (isDuplicate) {
        return state;
      }

      return {
        messages: {
          ...state.messages,
          [conversationId]: [...existingMessages, message],
        },
      };
    });
  },

  updateMessageStatus: (messageId: string, status: MessageStatus) => {
    set((state) => {
      const newMessages = { ...state.messages };

      for (const conversationId of Object.keys(newMessages)) {
        newMessages[conversationId] = newMessages[conversationId].map((m) =>
          m.id === messageId ? { ...m, status } : m
        );
      }

      return { messages: newMessages };
    });
  },

  updateMessageId: (clientMessageId: string, messageId: string, createdAt: string) => {
    set((state) => {
      const newMessages = { ...state.messages };

      for (const conversationId of Object.keys(newMessages)) {
        newMessages[conversationId] = newMessages[conversationId].map((m) =>
          m.clientMessageId === clientMessageId
            ? { ...m, id: messageId, created_at: createdAt, status: 'sent' as MessageStatus }
            : m
        );
      }

      const newPending = new Map(state.pendingMessages);
      newPending.delete(clientMessageId);

      return { messages: newMessages, pendingMessages: newPending };
    });
  },

  markMessagesAsRead: (messageIds: string[], conversationId: string) => {
    set((state) => {
      const messages = state.messages[conversationId];
      if (!messages) return state;

      const messageIdSet = new Set(messageIds);
      const updatedMessages = messages.map((m) =>
        messageIdSet.has(m.id) ? { ...m, status: 'read' as MessageStatus } : m
      );

      return {
        messages: {
          ...state.messages,
          [conversationId]: updatedMessages,
        },
      };
    });
  },

  setTyping: (conversationId: string, userId: string, isTyping: boolean) => {
    set((state) => {
      const current = state.typingUsers[conversationId] || [];

      if (isTyping && !current.includes(userId)) {
        return {
          typingUsers: {
            ...state.typingUsers,
            [conversationId]: [...current, userId],
          },
        };
      }

      if (!isTyping && current.includes(userId)) {
        return {
          typingUsers: {
            ...state.typingUsers,
            [conversationId]: current.filter((id) => id !== userId),
          },
        };
      }

      return state;
    });
  },

  updatePresence: (userId: string, status: 'online' | 'offline', lastSeen?: number) => {
    set((state) => ({
      userPresence: {
        ...state.userPresence,
        [userId]: {
          status,
          last_seen: lastSeen || Date.now(),
        },
      },
    }));
  },

  addConversation: (conversation: Conversation) => {
    set((state) => {
      const exists = state.conversations.some((c) => c.id === conversation.id);
      if (exists) {
        return {
          conversations: state.conversations.map((c) =>
            c.id === conversation.id ? conversation : c
          ),
        };
      }
      return {
        conversations: [conversation, ...state.conversations],
      };
    });
  },

  updateConversationLastMessage: (conversationId: string, message: Message) => {
    set((state) => ({
      conversations: state.conversations
        .map((c) =>
          c.id === conversationId
            ? { ...c, last_message: message, updated_at: message.created_at }
            : c
        )
        .sort(
          (a, b) =>
            new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
        ),
    }));
  },

  toggleReaction: async (conversationId: string, messageId: string, emoji: string) => {
    const state = get();
    const currentReactions = state.messageReactions[messageId] || [];
    const existingReaction = currentReactions.find((r) => r.emoji === emoji);
    const userReacted = existingReaction?.userReacted ?? false;

    try {
      if (userReacted) {
        const { reactions } = await reactionsApi.remove(conversationId, messageId, emoji);
        set((state) => ({
          messageReactions: {
            ...state.messageReactions,
            [messageId]: reactions,
          },
        }));
      } else {
        const { reactions } = await reactionsApi.add(conversationId, messageId, emoji);
        set((state) => ({
          messageReactions: {
            ...state.messageReactions,
            [messageId]: reactions,
          },
        }));
      }
    } catch (error) {
      console.error('Failed to toggle reaction:', error);
    }
  },

  updateMessageReactions: (messageId: string, reactions: ReactionSummary[]) => {
    set((state) => ({
      messageReactions: {
        ...state.messageReactions,
        [messageId]: reactions,
      },
    }));
  },
}));
