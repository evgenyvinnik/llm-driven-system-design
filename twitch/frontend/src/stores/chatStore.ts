import { create } from 'zustand';
import type { ChatMessage, Emote } from '../types';

interface ChatStore {
  socket: WebSocket | null;
  connected: boolean;
  authenticated: boolean;
  currentChannel: number | null;
  messages: ChatMessage[];
  viewerCount: number;
  emotes: Emote[];

  connect: () => void;
  disconnect: () => void;
  authenticate: (userId: number | null, username: string) => void;
  joinChannel: (channelId: number) => void;
  leaveChannel: (channelId: number) => void;
  sendMessage: (channelId: number, text: string) => void;
  setEmotes: (emotes: Emote[]) => void;
  clearMessages: () => void;
}

export const useChatStore = create<ChatStore>((set, get) => ({
  socket: null,
  connected: false,
  authenticated: false,
  currentChannel: null,
  messages: [],
  viewerCount: 0,
  emotes: [],

  connect: () => {
    const wsUrl = `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws/chat`;
    const socket = new WebSocket(wsUrl);

    socket.onopen = () => {
      console.log('Chat WebSocket connected');
      set({ socket, connected: true });
    };

    socket.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        handleMessage(data, set, get);
      } catch (error) {
        console.error('Failed to parse chat message:', error);
      }
    };

    socket.onclose = () => {
      console.log('Chat WebSocket disconnected');
      set({ socket: null, connected: false, authenticated: false });
    };

    socket.onerror = (error) => {
      console.error('Chat WebSocket error:', error);
    };

    set({ socket });
  },

  disconnect: () => {
    const { socket, currentChannel } = get();
    if (socket) {
      if (currentChannel) {
        socket.send(JSON.stringify({ type: 'leave', channelId: currentChannel }));
      }
      socket.close();
    }
    set({ socket: null, connected: false, authenticated: false, currentChannel: null, messages: [] });
  },

  authenticate: (userId, username) => {
    const { socket } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'auth', userId, username }));
    }
  },

  joinChannel: (channelId) => {
    const { socket, currentChannel } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      // Leave current channel first
      if (currentChannel && currentChannel !== channelId) {
        socket.send(JSON.stringify({ type: 'leave', channelId: currentChannel }));
      }
      socket.send(JSON.stringify({ type: 'join', channelId }));
      set({ currentChannel: channelId, messages: [] });
    }
  },

  leaveChannel: (channelId) => {
    const { socket } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'leave', channelId }));
      set({ currentChannel: null, messages: [] });
    }
  },

  sendMessage: (channelId, text) => {
    const { socket } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'chat', channelId, text }));
    }
  },

  setEmotes: (emotes) => {
    set({ emotes });
  },

  clearMessages: () => {
    set({ messages: [] });
  },
}));

function handleMessage(
  data: {
    type: string;
    channelId?: number;
    recentMessages?: ChatMessage[];
    viewerCount?: number;
    userId?: number;
    username?: string;
    message?: string;
    badges?: ChatMessage['badges'];
    timestamp?: number;
    id?: string;
    error?: string;
  },
  set: (state: Partial<ChatStore>) => void,
  get: () => ChatStore
) {
  switch (data.type) {
    case 'auth_success':
      set({ authenticated: true });
      break;

    case 'joined':
      if (data.recentMessages) {
        set({
          messages: data.recentMessages.map((m) => ({
            ...m,
            type: 'chat' as const,
            channelId: data.channelId!,
          })),
          viewerCount: data.viewerCount || 0,
        });
      }
      break;

    case 'chat':
      set({
        messages: [
          ...get().messages.slice(-199), // Keep last 200 messages
          {
            id: data.id || crypto.randomUUID(),
            type: 'chat',
            channelId: data.channelId!,
            userId: data.userId || null,
            username: data.username || 'Unknown',
            message: data.message || '',
            badges: data.badges || [],
            timestamp: data.timestamp || Date.now(),
          },
        ],
      });
      break;

    case 'viewer_update':
      set({ viewerCount: data.viewerCount || 0 });
      break;

    case 'error':
      set({
        messages: [
          ...get().messages,
          {
            id: crypto.randomUUID(),
            type: 'error',
            channelId: get().currentChannel || 0,
            userId: null,
            username: 'System',
            message: data.message || 'An error occurred',
            badges: [],
            timestamp: Date.now(),
          },
        ],
      });
      break;
  }
}
