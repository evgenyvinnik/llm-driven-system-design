import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Session, Room, Message } from '../types';
import * as api from '../services/api';

interface ChatState {
  // Session
  session: Session | null;
  isConnecting: boolean;
  connectionError: string | null;

  // Rooms
  rooms: Room[];
  currentRoom: string | null;
  isLoadingRooms: boolean;

  // Messages
  messages: Message[];
  isLoadingMessages: boolean;

  // SSE
  eventSource: EventSource | null;

  // Actions
  connect: (nickname: string) => Promise<void>;
  disconnect: () => Promise<void>;
  refreshRooms: () => Promise<void>;
  createRoom: (name: string) => Promise<void>;
  joinRoom: (name: string) => Promise<void>;
  leaveRoom: () => Promise<void>;
  sendMessage: (content: string) => Promise<void>;
  addMessage: (message: Message) => void;
  clearMessages: () => void;
}

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
