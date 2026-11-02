import type { PriceData } from '../types';

type MessageHandler = (data: Record<string, unknown>) => void;
type PriceHandler = (prices: Record<string, PriceData>) => void;

/** WebSocket client with auto-reconnect, channel subscriptions, and price update handlers. */
class WebSocketClient {
  private ws: WebSocket | null = null;
  private messageHandlers: Map<string, MessageHandler[]> = new Map();
  private priceHandlers: PriceHandler[] = [];
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private subscriptions: Set<string> = new Set();

  connect(): void {
    if (
      this.ws?.readyState === WebSocket.OPEN ||
      this.ws?.readyState === WebSocket.CONNECTING
    ) {
      return;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    this.ws = new WebSocket(`${protocol}//${host}/ws`);

    this.ws.onopen = () => {
      this.reconnectAttempts = 0;

      // Resubscribe to channels
      if (this.subscriptions.size > 0) {
        this.ws?.send(
          JSON.stringify({
            type: 'subscribe',
            channels: Array.from(this.subscriptions),
          })
        );
      }
    };

    this.ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);

        // Handle price broadcast
        if (data.type === 'prices' && data.data) {
          for (const handler of this.priceHandlers) {
            handler(data.data);
          }
          return;
        }

        // Handle channel-specific messages
        if (data.channel) {
          const handlers = this.messageHandlers.get(data.channel) || [];
          for (const handler of handlers) {
            handler(data);
          }
        }

        // Handle type-specific messages
        if (data.type) {
          const handlers = this.messageHandlers.get(data.type) || [];
          for (const handler of handlers) {
            handler(data);
          }
        }
      } catch (_err) {
        // Ignore parse errors
      }
    };

    const socket = this.ws;
    socket.onclose = () => {
      // A socket replaced by reconnect() must not schedule a second connection.
      if (this.ws === socket) this.attemptReconnect();
    };

    this.ws.onerror = () => {
      // Error will trigger onclose
    };
  }

  private attemptReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) return;

    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
    this.reconnectAttempts++;

    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, delay);
  }

  subscribe(channels: string[]): void {
    for (const ch of channels) {
      this.subscriptions.add(ch);
    }

    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(
        JSON.stringify({
          type: 'subscribe',
          channels,
        })
      );
    }
  }

  unsubscribe(channels: string[]): void {
    for (const ch of channels) {
      this.subscriptions.delete(ch);
    }

    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(
        JSON.stringify({
          type: 'unsubscribe',
          channels,
        })
      );
    }
  }

  onMessage(channel: string, handler: MessageHandler): () => void {
    const handlers = this.messageHandlers.get(channel) || [];
    handlers.push(handler);
    this.messageHandlers.set(channel, handlers);

    return () => {
      const current = this.messageHandlers.get(channel) || [];
      this.messageHandlers.set(
        channel,
        current.filter((h) => h !== handler)
      );
    };
  }

  onPriceUpdate(handler: PriceHandler): () => void {
    this.priceHandlers.push(handler);
    return () => {
      this.priceHandlers = this.priceHandlers.filter((h) => h !== handler);
    };
  }

  /**
   * Drops the current socket and opens a new one. The server reads identity
   * from the session cookie during the upgrade, so after login or logout the
   * socket must be reopened to gain (or lose) the private order channel.
   */
  reconnect(): void {
    const previous = this.ws;
    this.ws = null;
    previous?.close();
    this.reconnectAttempts = 0;
    this.connect();
  }

  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }
    this.ws?.close();
    this.ws = null;
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}

/** Singleton WebSocket client instance for the application. */
export const wsClient = new WebSocketClient();
