import { create } from 'zustand';
import type { Conversation, Message, TypingUser, WebSocketMessage } from '@/types';
import { api } from '@/services/api';
import { wsService } from '@/services/websocket';
import { useAuthStore } from '@/stores/authStore';
import { newClientId } from '@/lib/ids';
import {
  upsertMessage,
  mergeMessages,
  markDelivered,
  markReadUpTo,
  highestSeq,
  hasGap,
} from '@/lib/messageList';

const PAGE_SIZE = 50;
/** A typing indicator disappears on its own if the "stopped typing" event is lost */
const TYPING_TTL_MS = 6000;
const typingExpiry = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Chat state interface.
 * Manages conversations, messages, typing indicators, and real-time updates.
 * Messages are kept per conversation, ordered by the server's seq.
 */
interface ChatState {
  /** All conversations the user is participating in */
  conversations: Conversation[];
  /** Currently selected conversation ID for the chat view */
  currentConversationId: string | null;
  /** Messages indexed by conversation ID, ordered by seq */
  messages: Map<string, Message[]>;
  /** Users currently typing, indexed by conversation ID */
  typingUsers: Map<string, TypingUser[]>;
  /** Conversations whose oldest message has been loaded */
  historyComplete: Set<string>;
  /** Loading state for conversations list */
  isLoadingConversations: boolean;
  /** Loading state for messages in current conversation */
  isLoadingMessages: boolean;
  /** Loading state for an older history page */
  isLoadingOlder: boolean;

  /** Fetches all conversations from the server */
  loadConversations: () => Promise<void>;
  /** Selects a conversation and loads its messages */
  selectConversation: (id: string | null) => void;
  /** Loads the newest page of a conversation and merges it with what is already here */
  loadMessages: (conversationId: string) => Promise<void>;
  /** Loads the page before the oldest loaded message (keyset pagination on seq) */
  loadOlderMessages: (conversationId: string) => Promise<void>;
  /** Sends a message with an optimistic bubble and a client ID reused on every retry */
  sendMessage: (conversationId: string, content: string, replyToId?: string) => Promise<void>;
  /** Resends a failed message with its original client ID (the server dedupes) */
  retryMessage: (conversationId: string, clientMessageId: string) => void;
  /**
   * Applies messages from any source (live push, sync batch). Idempotent:
   * duplicates merge, order follows seq, and every message is acknowledged
   * so the server can drop it from this device's inbox.
   */
  receiveMessages: (incoming: Message[], live: boolean) => void;
  /** Sends typing indicator via WebSocket */
  setTyping: (conversationId: string, isTyping: boolean) => void;
  /** Processes incoming WebSocket messages and updates state accordingly */
  handleWebSocketMessage: (message: WebSocketMessage) => void;
  /** Creates a new direct (1:1) conversation */
  createDirectConversation: (userId: string) => Promise<Conversation>;
  /** Creates a new group conversation */
  createGroupConversation: (name: string, participantIds: string[]) => Promise<Conversation>;
  /** Advances this device's read watermark and clears the local unread count */
  markAsRead: (conversationId: string, messageId: string) => void;
  /** Updates a conversation's properties in state */
  updateConversation: (conversationId: string, updates: Partial<Conversation>) => void;
  /** Clears all chat state (on logout) */
  reset: () => void;
}

const initialState = {
  conversations: [] as Conversation[],
  currentConversationId: null as string | null,
  messages: new Map<string, Message[]>(),
  typingUsers: new Map<string, TypingUser[]>(),
  historyComplete: new Set<string>(),
  isLoadingConversations: false,
  isLoadingMessages: false,
  isLoadingOlder: false,
};

const currentUserId = () => useAuthStore.getState().user?.id ?? '';

/**
 * Zustand store for chat state management.
 */
export const useChatStore = create<ChatState>((set, get) => ({
  ...initialState,

  loadConversations: async () => {
    set({ isLoadingConversations: true });
    try {
      const response = await api.getConversations();
      set({ conversations: response.conversations });
    } catch (error) {
      console.error('Failed to load conversations:', error);
    } finally {
      set({ isLoadingConversations: false });
    }
  },

  selectConversation: (id: string | null) => {
    set({ currentConversationId: id });
    if (id) {
      get().loadMessages(id);
    }
  },

  loadMessages: async (conversationId: string) => {
    set({ isLoadingMessages: true });
    try {
      const response = await api.getMessages(conversationId, { limit: PAGE_SIZE });
      // Merge rather than replace: optimistic bubbles and live messages that
      // arrived during the request must survive
      const messages = new Map(get().messages);
      const merged = mergeMessages(messages.get(conversationId) ?? [], response.messages);
      messages.set(conversationId, merged);

      const historyComplete = new Set(get().historyComplete);
      if (response.messages.length < PAGE_SIZE) historyComplete.add(conversationId);
      set({ messages, historyComplete });

      const lastConfirmed = [...merged].reverse().find((m) => m.seq !== undefined);
      if (lastConfirmed) {
        get().markAsRead(conversationId, lastConfirmed.id);
      }
    } catch (error) {
      console.error('Failed to load messages:', error);
    } finally {
      set({ isLoadingMessages: false });
    }
  },

  loadOlderMessages: async (conversationId: string) => {
    const current = get().messages.get(conversationId) ?? [];
    const oldest = current.find((m) => m.seq !== undefined)?.seq;
    if (oldest === undefined || oldest <= 1 || get().isLoadingOlder) return;

    set({ isLoadingOlder: true });
    try {
      const response = await api.getMessages(conversationId, { limit: PAGE_SIZE, beforeSeq: oldest });
      const messages = new Map(get().messages);
      messages.set(conversationId, mergeMessages(messages.get(conversationId) ?? [], response.messages));
      const historyComplete = new Set(get().historyComplete);
      if (response.messages.length < PAGE_SIZE) historyComplete.add(conversationId);
      set({ messages, historyComplete });
    } catch (error) {
      console.error('Failed to load older messages:', error);
    } finally {
      set({ isLoadingOlder: false });
    }
  },

  sendMessage: async (conversationId: string, content: string, replyToId?: string) => {
    // Generated once; every retry of this message reuses it
    const clientMessageId = newClientId();
    const user = useAuthStore.getState().user;

    const tempMessage: Message = {
      id: clientMessageId,
      conversation_id: conversationId,
      sender_id: user?.id ?? '',
      content,
      content_type: 'text',
      reply_to_id: replyToId || null,
      edited_at: null,
      created_at: new Date().toISOString(),
      sender_username: user?.username ?? '',
      sender_display_name: user?.display_name ?? '',
      sender_avatar_url: user?.avatar_url ?? null,
      reactions: null,
      reply_to: null,
      status: 'sending',
      clientMessageId,
    };

    const messages = new Map(get().messages);
    messages.set(conversationId, upsertMessage(messages.get(conversationId) ?? [], tempMessage));
    set({ messages });

    // Queued by the WebSocket service while disconnected
    wsService.sendMessage(conversationId, content, { clientMessageId, replyToId });
  },

  retryMessage: (conversationId: string, clientMessageId: string) => {
    const list = get().messages.get(conversationId) ?? [];
    const failed = list.find((m) => m.clientMessageId === clientMessageId && m.status === 'failed');
    if (!failed) return;

    const messages = new Map(get().messages);
    messages.set(
      conversationId,
      list.map((m) => (m === failed ? { ...m, status: 'sending' as const } : m))
    );
    set({ messages });
    wsService.sendMessage(conversationId, failed.content, {
      clientMessageId,
      replyToId: failed.reply_to_id ?? undefined,
    });
  },

  receiveMessages: (incoming: Message[], live: boolean) => {
    if (incoming.length === 0) return;
    const me = currentUserId();
    const state = get();
    const messages = new Map(state.messages);
    let conversations = [...state.conversations];
    let unknownConversation = false;
    let gapDetected = false;
    const toMarkRead: { conversationId: string; messageId: string }[] = [];

    const byConversation = new Map<string, Message[]>();
    for (const message of incoming) {
      const group = byConversation.get(message.conversation_id) ?? [];
      group.push(message);
      byConversation.set(message.conversation_id, group);
    }

    for (const [conversationId, batch] of byConversation) {
      const current = messages.get(conversationId) ?? [];
      const convIndex = conversations.findIndex((c) => c.id === conversationId);
      const conversation = convIndex >= 0 ? conversations[convIndex] : undefined;
      // What this client had already seen, from the loaded list or the
      // conversation list (whose unread_count already covers up to that seq)
      const knownMax = Math.max(highestSeq(current), conversation?.last_message?.seq ?? 0);

      if (live && batch.some((m) => hasGap(knownMax, m.seq))) {
        gapDetected = true;
      }

      messages.set(conversationId, mergeMessages(current, batch));

      if (!conversation) {
        unknownConversation = true;
        continue;
      }

      const fresh = batch.filter((m) => !m.deleted_at && (m.seq ?? 0) > knownMax);
      if (fresh.length === 0) continue;

      const newest = fresh.reduce((a, b) => ((a.seq ?? 0) >= (b.seq ?? 0) ? a : b));
      const fromOthers = fresh.filter((m) => m.sender_id !== me);
      const isOpen = state.currentConversationId === conversationId;

      const updated: Conversation = {
        ...conversation,
        last_message: newest,
        updated_at: newest.created_at,
        unread_count: isOpen ? conversation.unread_count : conversation.unread_count + fromOthers.length,
      };
      conversations = [updated, ...conversations.filter((c) => c.id !== conversationId)];

      if (isOpen && fromOthers.length > 0) {
        toMarkRead.push({ conversationId, messageId: newest.id });
      }
    }

    set({ messages, conversations });

    // Acknowledge everything, including duplicates: the ack is what removes
    // the message from this device's server-side inbox
    wsService.sendAck(incoming.map((m) => m.id));

    for (const { conversationId, messageId } of toMarkRead) {
      get().markAsRead(conversationId, messageId);
    }
    if (gapDetected) {
      // A live push skipped a seq: pull whatever this device's inbox still holds
      wsService.requestSync();
    }
    if (unknownConversation) {
      // Someone added us to a conversation this tab has not listed yet
      get().loadConversations();
    }
  },

  setTyping: (conversationId: string, isTyping: boolean) => {
    wsService.sendTyping(conversationId, isTyping);
  },

  handleWebSocketMessage: (message: WebSocketMessage) => {
    switch (message.type) {
      case 'new_message': {
        get().receiveMessages([message.message as Message], true);
        break;
      }

      case 'sync_batch': {
        // Backlog for this device: everything sent while it was away
        get().receiveMessages(message.messages as Message[], false);
        if (message.hasMore) {
          wsService.requestSync();
        }
        break;
      }

      case 'message_sent': {
        // The server's ack: replaces the optimistic bubble (matched by client ID)
        const sent = message.message as Message;
        const messages = new Map(get().messages);
        const list = messages.get(sent.conversation_id) ?? [];
        messages.set(
          sent.conversation_id,
          upsertMessage(list, { ...sent, clientMessageId: message.clientMessageId as string, status: 'sent' })
        );
        set({ messages });
        break;
      }

      case 'delivery_receipt': {
        const conversationId = message.conversationId as string;
        const list = get().messages.get(conversationId);
        if (list) {
          const messages = new Map(get().messages);
          messages.set(conversationId, markDelivered(list, message.messageIds as string[], currentUserId()));
          set({ messages });
        }
        break;
      }

      case 'read_receipt': {
        const conversationId = message.conversationId as string;
        const seq = message.seq as number;
        if (message.userId === currentUserId()) {
          // Read on another of my devices: clear the badge here too
          const conversation = get().conversations.find((c) => c.id === conversationId);
          if (conversation && seq >= (conversation.last_message?.seq ?? 0)) {
            get().updateConversation(conversationId, { unread_count: 0 });
          }
        } else {
          const list = get().messages.get(conversationId);
          if (list) {
            const messages = new Map(get().messages);
            messages.set(conversationId, markReadUpTo(list, seq, currentUserId()));
            set({ messages });
          }
        }
        break;
      }

      case 'typing': {
        const conversationId = message.conversationId as string;
        const userId = message.userId as string;
        const removeTyper = () => {
          const typingUsers = new Map(get().typingUsers);
          typingUsers.set(conversationId, (typingUsers.get(conversationId) ?? []).filter((u) => u.userId !== userId));
          set({ typingUsers });
        };

        const timerKey = `${conversationId}:${userId}`;
        clearTimeout(typingExpiry.get(timerKey));
        typingExpiry.delete(timerKey);

        if (!message.isTyping) {
          removeTyper();
          break;
        }
        const typingUsers = new Map(get().typingUsers);
        const convTyping = (typingUsers.get(conversationId) ?? []).filter((u) => u.userId !== userId);
        convTyping.push({
          userId,
          username: message.username as string,
          displayName: message.displayName as string,
        });
        typingUsers.set(conversationId, convTyping);
        set({ typingUsers });
        typingExpiry.set(timerKey, setTimeout(removeTyper, TYPING_TTL_MS));
        break;
      }

      case 'reaction_update': {
        const conversationId = message.conversationId as string;
        const convMessages = get().messages.get(conversationId);
        if (!convMessages) break;
        const msgIndex = convMessages.findIndex((m) => m.id === message.messageId);
        if (msgIndex < 0) break;

        const msg = { ...convMessages[msgIndex] };
        const reactions = (msg.reactions ?? []).filter(
          (r) => !(r.user_id === message.userId && r.reaction === message.reaction)
        );
        if (!message.remove) {
          reactions.push({ id: '', user_id: message.userId as string, reaction: message.reaction as string });
        }
        msg.reactions = reactions;

        const messages = new Map(get().messages);
        const updated = [...convMessages];
        updated[msgIndex] = msg;
        messages.set(conversationId, updated);
        set({ messages });
        break;
      }

      case 'error': {
        console.error('WebSocket error:', message.code, message.error);
        // A rejected send: show "Not delivered" with a retry instead of spinning forever
        const clientMessageId = message.clientMessageId as string | undefined;
        if (!clientMessageId) break;
        const messages = new Map(get().messages);
        for (const [conversationId, list] of messages) {
          if (list.some((m) => m.clientMessageId === clientMessageId && m.status === 'sending')) {
            messages.set(
              conversationId,
              list.map((m) => (m.clientMessageId === clientMessageId ? { ...m, status: 'failed' as const } : m))
            );
            set({ messages });
            break;
          }
        }
        break;
      }
    }
  },

  createDirectConversation: async (userId: string) => {
    const response = await api.createDirectConversation(userId);
    const conversations = [
      response.conversation,
      ...get().conversations.filter((c) => c.id !== response.conversation.id),
    ];
    set({ conversations });
    return response.conversation;
  },

  createGroupConversation: async (name: string, participantIds: string[]) => {
    const response = await api.createGroupConversation(name, participantIds);
    const conversations = [response.conversation, ...get().conversations];
    set({ conversations });
    return response.conversation;
  },

  markAsRead: (conversationId: string, messageId: string) => {
    wsService.sendRead(conversationId, messageId);
    get().updateConversation(conversationId, { unread_count: 0 });
  },

  updateConversation: (conversationId: string, updates: Partial<Conversation>) => {
    const conversations = get().conversations.map((c) => {
      if (c.id === conversationId) {
        return { ...c, ...updates };
      }
      return c;
    });
    set({ conversations });
  },

  reset: () => {
    set({
      ...initialState,
      messages: new Map(),
      typingUsers: new Map(),
      historyComplete: new Set(),
    });
  },
}));

// Logging out (or in as someone else) must not leave the previous account's
// conversations and messages in memory
useAuthStore.subscribe((state, previous) => {
  if (previous.isAuthenticated && !state.isAuthenticated) {
    typingExpiry.forEach((timer) => clearTimeout(timer));
    typingExpiry.clear();
    useChatStore.getState().reset();
  }
});
