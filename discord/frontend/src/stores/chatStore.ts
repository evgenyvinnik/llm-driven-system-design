/**
 * Chat Store Module
 *
 * Central state management for the Baby Discord frontend using Zustand.
 * Manages user sessions, room state, and message handling with persistence.
 * The store uses the persist middleware to save session data to localStorage,
 * allowing users to maintain their session across page refreshes.
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Session, Room, Message } from '../types';
import * as api from '../services/api';

/**
 * Shape of the chat store state and actions.
 * Combines reactive state with methods for session and room management.
 */
interface ChatState {
  /** Current user session, null if not logged in */
  session: Session | null;
  /** Whether a connection attempt is in progress */
  isConnecting: boolean;
  /** Error message from failed connection attempt */
  connectionError: string | null;

  /** List of available chat rooms */
  rooms: Room[];
  /** Name of the room the user is currently in */
  currentRoom: string | null;
  /** Whether room list is being loaded */
  isLoadingRooms: boolean;

  /** Messages in the current room */
  messages: Message[];
  /** Whether message history is being loaded */
  isLoadingMessages: boolean;

  /** Active SSE connection for real-time messages */
  eventSource: EventSource | null;

  /**
   * Connect to the chat server with a nickname.
   * @param nickname - Display name for the user
   */
  connect: (nickname: string) => Promise<void>;
  /** Disconnect from the server and clean up state */
  disconnect: () => Promise<void>;
  /** Refresh the list of available rooms from the server */
  refreshRooms: () => Promise<void>;
  /**
   * Create a new chat room and join it.
   * @param name - Name for the new room
   */
  createRoom: (name: string) => Promise<void>;
  /**
   * Join an existing room and start receiving messages.
   * @param name - Name of the room to join
   */
  joinRoom: (name: string) => Promise<void>;
  /** Leave the current room and stop receiving messages */
  leaveRoom: () => Promise<void>;
  /**
   * Send a message to the current room.
   * @param content - Message text to send
   */
  sendMessage: (content: string) => Promise<void>;
  /**
   * Add a message to the local message list (used by SSE handler).
   * @param message - Message to add
   */
  addMessage: (message: Message) => void;
  /** Clear all messages from local state */
  clearMessages: () => void;
}

/**
 * Global chat store using Zustand with persistence.
 * Session data is persisted to localStorage under 'baby-discord-session'.
 * Only the session object is persisted; rooms and messages are ephemeral.
 */
export const useChatStore = create<ChatState>()(
  persist(
    (set, get) => ({
      session: null,
      isConnecting: false,
      connectionError: null,
      rooms: [],
      currentRoom: null,
      isLoadingRooms: false,
      messages: [],
      isLoadingMessages: false,
      eventSource: null,

      connect: async (nickname: string) => {
        set({ isConnecting: true, connectionError: null });
        try {
          const session = await api.connect(nickname);
          set({ session, isConnecting: false });
          // Load rooms after connecting
          get().refreshRooms();
        } catch (error) {
          set({
            isConnecting: false,
            connectionError:
              error instanceof Error ? error.message : 'Failed to connect',
          });
        }
      },

      disconnect: async () => {
        const { session, eventSource } = get();
        if (session) {
          await api.disconnect(session.sessionId);
        }
        if (eventSource) {
          eventSource.close();
        }
        set({
          session: null,
          currentRoom: null,
          messages: [],
          eventSource: null,
        });
      },

      refreshRooms: async () => {
        set({ isLoadingRooms: true });
        try {
          const rooms = await api.getRooms();
          set({ rooms, isLoadingRooms: false });
        } catch {
          set({ isLoadingRooms: false });
        }
      },

      createRoom: async (name: string) => {
        const { session } = get();
        if (!session) return;

        const result = await api.executeCommand(
          session.sessionId,
          `/create ${name}`
        );
        if (result.success) {
          await get().refreshRooms();
          await get().joinRoom(name);
        }
      },

      joinRoom: async (name: string) => {
        const { session, eventSource } = get();
        if (!session) return;

        // Close existing SSE connection
        if (eventSource) {
          eventSource.close();
        }

        set({ isLoadingMessages: true });

        const result = await api.executeCommand(
          session.sessionId,
          `/join ${name}`
        );

        if (result.success) {
          // Load history
          const history = await api.getRoomHistory(name);
          set({ currentRoom: name, messages: history, isLoadingMessages: false });

          // Set up SSE for real-time messages
          const newEventSource = api.createSSEConnection(
            name,
            session.sessionId,
            (message) => {
              get().addMessage(message);
            },
            (error) => {
              console.error('SSE error:', error);
            }
          );

          set({ eventSource: newEventSource });
        } else {
          set({ isLoadingMessages: false });
        }
      },

      leaveRoom: async () => {
        const { session, eventSource } = get();
        if (!session) return;

        if (eventSource) {
          eventSource.close();
        }

        await api.executeCommand(session.sessionId, '/leave');
        set({ currentRoom: null, messages: [], eventSource: null });
      },

      sendMessage: async (content: string) => {
        const { session } = get();
        if (!session) return;

        await api.sendMessage(session.sessionId, content);
      },

      addMessage: (message: Message) => {
        set((state) => ({
          messages: [...state.messages, message],
        }));
      },

      clearMessages: () => {
        set({ messages: [] });
      },
    }),
    {
      name: 'baby-discord-session',
      partialize: (state) => ({
        session: state.session,
      }),
    }
  )
);
