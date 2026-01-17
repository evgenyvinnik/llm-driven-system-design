/**
 * WebSocket service for real-time quote streaming.
 * Connects to the backend WebSocket server and provides quote updates
 * to subscribed components. Handles automatic reconnection.
 */

import type { Quote } from '../types';

/** Callback for receiving quote updates */
type MessageHandler = (quotes: Quote[]) => void;
/** Callback for connection state changes */
type ConnectionHandler = (connected: boolean) => void;

/**
 * Singleton WebSocket service for managing real-time quote subscriptions.
 * Provides automatic reconnection, symbol subscription management,
 * and event handling for quote updates and connection state changes.
 */
class WebSocketService {
  private ws: WebSocket | null = null;
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private messageHandlers: Set<MessageHandler> = new Set();
  private connectionHandlers: Set<ConnectionHandler> = new Set();
  private subscribedSymbols: Set<string> = new Set();
  private isConnecting = false;

  /**
   * Establishes WebSocket connection to the backend.
   * Automatically resubscribes to previously subscribed symbols on reconnect.
   */
  connect(): void {
    if (this.ws?.readyState === WebSocket.OPEN || this.isConnecting) {
      return;
    }

    this.isConnecting = true;
    const token = localStorage.getItem('token');
    const wsUrl = `ws://${window.location.hostname}:3001/ws${token ? `?token=${token}` : ''}`;

    try {
      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        console.log('WebSocket connected');
        this.isConnecting = false;
        this.notifyConnectionHandlers(true);

        // Resubscribe to previously subscribed symbols
        if (this.subscribedSymbols.size > 0) {
          this.subscribe(Array.from(this.subscribedSymbols));
        }
      };

      this.ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          if (message.type === 'quotes' && Array.isArray(message.data)) {
            this.notifyMessageHandlers(message.data);
          }
        } catch (error) {
          console.error('WebSocket message parse error:', error);
        }
      };

      this.ws.onclose = () => {
        console.log('WebSocket disconnected');
        this.isConnecting = false;
        this.notifyConnectionHandlers(false);
        this.scheduleReconnect();
      };

      this.ws.onerror = (error) => {
        console.error('WebSocket error:', error);
        this.isConnecting = false;
      };
    } catch (error) {
      console.error('WebSocket connection error:', error);
      this.isConnecting = false;
      this.scheduleReconnect();
    }
  }

  /**
   * Closes the WebSocket connection and cancels any pending reconnect.
   */
  disconnect(): void {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  /**
   * Schedules automatic reconnection after 3 seconds.
   */
  private scheduleReconnect(): void {
    if (this.reconnectTimeout) return;

    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = null;
      this.connect();
    }, 3000);
  }

  /**
   * Subscribes to quote updates for the specified symbols.
   * @param symbols - Array of stock ticker symbols
   */
  subscribe(symbols: string[]): void {
    symbols.forEach((s) => this.subscribedSymbols.add(s.toUpperCase()));

    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        type: 'subscribe',
        symbols: symbols.map((s) => s.toUpperCase()),
      }));
    }
  }

  /**
   * Unsubscribes from quote updates for the specified symbols.
   * @param symbols - Array of stock ticker symbols
   */
  unsubscribe(symbols: string[]): void {
    symbols.forEach((s) => this.subscribedSymbols.delete(s.toUpperCase()));

    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        type: 'unsubscribe',
        symbols: symbols.map((s) => s.toUpperCase()),
      }));
    }
  }

  /**
   * Subscribes to quote updates for all available symbols.
   */
  subscribeAll(): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'subscribe_all' }));
    }
  }

  /**
   * Registers a handler for quote update messages.
   * @param handler - Callback to invoke with quote array
   * @returns Cleanup function to unregister the handler
   */
  onMessage(handler: MessageHandler): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  /**
   * Registers a handler for connection state changes.
   * @param handler - Callback to invoke with connection status
   * @returns Cleanup function to unregister the handler
   */
  onConnectionChange(handler: ConnectionHandler): () => void {
    this.connectionHandlers.add(handler);
    return () => this.connectionHandlers.delete(handler);
  }

  /**
   * Notifies all registered message handlers with quote updates.
   * @param quotes - Array of updated quotes
   */
  private notifyMessageHandlers(quotes: Quote[]): void {
    this.messageHandlers.forEach((handler) => {
      try {
        handler(quotes);
      } catch (error) {
        console.error('Message handler error:', error);
      }
    });
  }

  /**
   * Notifies all registered connection handlers with state change.
   * @param connected - Current connection state
   */
  private notifyConnectionHandlers(connected: boolean): void {
    this.connectionHandlers.forEach((handler) => {
      try {
        handler(connected);
      } catch (error) {
        console.error('Connection handler error:', error);
      }
    });
  }

  /**
   * Returns current WebSocket connection status.
   * @returns true if WebSocket is open and connected
   */
  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}

/**
 * Singleton instance of the WebSocket service.
 * Used throughout the app for real-time quote streaming.
 */
export const wsService = new WebSocketService();
