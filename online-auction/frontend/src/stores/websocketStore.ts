import { create } from 'zustand';
import type { WebSocketMessage } from '../types';

interface WebSocketState {
  socket: WebSocket | null;
  isConnected: boolean;
  subscribedAuctions: Set<string>;
  lastMessage: WebSocketMessage | null;
  connect: (token?: string) => void;
  disconnect: () => void;
  subscribe: (auctionId: string) => void;
  unsubscribe: (auctionId: string) => void;
  addMessageListener: (callback: (message: WebSocketMessage) => void) => () => void;
}

const messageListeners = new Set<(message: WebSocketMessage) => void>();

export const useWebSocketStore = create<WebSocketState>((set, get) => ({
  socket: null,
  isConnected: false,
  subscribedAuctions: new Set(),
  lastMessage: null,

  connect: (token?: string) => {
    const { socket: existingSocket } = get();
    if (existingSocket?.readyState === WebSocket.OPEN) {
      return;
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws${token ? `?token=${token}` : ''}`;

    const socket = new WebSocket(wsUrl);

    socket.onopen = () => {
      console.log('WebSocket connected');
      set({ isConnected: true });

      // Resubscribe to auctions
      const { subscribedAuctions } = get();
      subscribedAuctions.forEach((auctionId) => {
        socket.send(JSON.stringify({ type: 'subscribe', auction_id: auctionId }));
      });
    };

    socket.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data) as WebSocketMessage;
        set({ lastMessage: message });

        // Notify all listeners
        messageListeners.forEach((listener) => listener(message));
      } catch (error) {
        console.error('Failed to parse WebSocket message:', error);
      }
    };

    socket.onclose = () => {
      console.log('WebSocket disconnected');
      set({ isConnected: false, socket: null });

      // Attempt to reconnect after 3 seconds
      setTimeout(() => {
        const { socket: currentSocket } = get();
        if (!currentSocket) {
          get().connect(token);
        }
      }, 3000);
    };

    socket.onerror = (error) => {
      console.error('WebSocket error:', error);
    };

    set({ socket });
  },

  disconnect: () => {
    const { socket } = get();
    if (socket) {
      socket.close();
      set({ socket: null, isConnected: false });
    }
  },

  subscribe: (auctionId: string) => {
    const { socket, subscribedAuctions, isConnected } = get();

    subscribedAuctions.add(auctionId);
    set({ subscribedAuctions: new Set(subscribedAuctions) });

    if (socket && isConnected) {
      socket.send(JSON.stringify({ type: 'subscribe', auction_id: auctionId }));
    }
  },

  unsubscribe: (auctionId: string) => {
    const { socket, subscribedAuctions, isConnected } = get();

    subscribedAuctions.delete(auctionId);
    set({ subscribedAuctions: new Set(subscribedAuctions) });

    if (socket && isConnected) {
      socket.send(JSON.stringify({ type: 'unsubscribe', auction_id: auctionId }));
    }
  },

  addMessageListener: (callback: (message: WebSocketMessage) => void) => {
    messageListeners.add(callback);
    return () => messageListeners.delete(callback);
  },
}));
