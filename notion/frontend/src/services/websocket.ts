/**
 * @fileoverview WebSocket client for real-time collaboration features.
 * Handles connection management, page subscriptions, presence updates,
 * and operation broadcasting with automatic reconnection logic.
 */

import type { Presence, WSMessage, Operation } from '@/types';

/** Handler function for incoming WebSocket messages */
type MessageHandler = (message: WSMessage) => void;

/** Handler function for connection state changes */
type ConnectionHandler = () => void;

/**
 * WebSocket service for real-time communication with the server.
 * Provides methods for subscribing to pages, sending operations,
 * and updating presence. Automatically reconnects on disconnection.
 */
class WebSocketService {
  private ws: WebSocket | null = null;
  private token: string | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectTimeout: number | null = null;
  private messageHandlers: Set<MessageHandler> = new Set();
  private connectionHandlers: Set<ConnectionHandler> = new Set();
  private disconnectionHandlers: Set<ConnectionHandler> = new Set();
  private pendingMessages: WSMessage[] = [];
  private clientId: string | null = null;

  /**
   * Establishes a WebSocket connection with the server.
   * Uses the authentication token for session verification.
   *
   * @param token - Session token for authentication
   */
  connect(token: string): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      return;
    }

    this.token = token;
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    const url = `${protocol}//${host}/ws?token=${token}`;

    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      console.log('WebSocket connected');
      this.reconnectAttempts = 0;
      this.connectionHandlers.forEach((handler) => handler());

      // Send pending messages
      while (this.pendingMessages.length > 0) {
        const message = this.pendingMessages.shift()!;
        this.send(message);
      }
    };

    this.ws.onmessage = (event) => {
      try {
        const message: WSMessage = JSON.parse(event.data);

        // Handle connected message
        if (message.type === 'connected') {
          const payload = message.payload as { clientId: string };
          this.clientId = payload.clientId;
        }

        this.messageHandlers.forEach((handler) => handler(message));
      } catch (error) {
        console.error('Failed to parse WebSocket message:', error);
      }
    };

    this.ws.onclose = () => {
      console.log('WebSocket disconnected');
      this.disconnectionHandlers.forEach((handler) => handler());
      this.attemptReconnect();
    };

    this.ws.onerror = (error) => {
      console.error('WebSocket error:', error);
    };
  }

  /**
   * Closes the WebSocket connection and prevents automatic reconnection.
   * Called on logout or when leaving the application.
   */
  disconnect(): void {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    this.reconnectAttempts = this.maxReconnectAttempts; // Prevent reconnection
    this.ws?.close();
    this.ws = null;
    this.clientId = null;
  }

  private attemptReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.log('Max reconnection attempts reached');
      return;
    }

    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
    this.reconnectAttempts++;

    console.log(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);

    this.reconnectTimeout = window.setTimeout(() => {
      if (this.token) {
        this.connect(this.token);
      }
    }, delay);
  }

  /**
   * Sends a message through the WebSocket connection.
   * If not connected, queues the message to be sent when connection opens.
   *
   * @param message - The message to send
   */
  send(message: WSMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    } else {
      this.pendingMessages.push(message);
    }
  }

  /**
   * Subscribes to real-time updates for a specific page.
   * Receives presence updates and operations from other users.
   *
   * @param pageId - The page to subscribe to
   */
  subscribePage(pageId: string): void {
    this.send({
      type: 'subscribe',
      payload: { pageId },
    });
  }

  /**
   * Unsubscribes from the currently subscribed page.
   * Removes presence and stops receiving updates.
   */
  unsubscribePage(): void {
    this.send({
      type: 'unsubscribe',
      payload: {},
    });
  }

  /**
   * Sends an editing operation to be broadcast to other users.
   *
   * @param operation - The operation to send (timestamp and author added by server)
   */
  sendOperation(operation: Omit<Operation, 'timestamp' | 'author_id'>): void {
    this.send({
      type: 'operation',
      payload: operation,
    });
  }

  /**
   * Updates the user's cursor position for presence display.
   *
   * @param cursorPosition - The current cursor location (block and offset)
   */
  updatePresence(cursorPosition?: { block_id: string; offset: number }): void {
    this.send({
      type: 'presence',
      payload: { cursor_position: cursorPosition },
    });
  }

  /**
   * Requests operations that occurred since a given timestamp.
   * Used to sync after reconnection or when returning to a page.
   *
   * @param since - Timestamp to sync from (operations after this time)
   */
  requestSync(since: number): void {
    this.send({
      type: 'sync',
      payload: { since },
    });
  }

  /**
   * Registers a handler for incoming WebSocket messages.
   *
   * @param handler - Function to call when a message is received
   * @returns Unsubscribe function to remove the handler
   */
  onMessage(handler: MessageHandler): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  /**
   * Registers a handler for successful connection events.
   *
   * @param handler - Function to call when connected
   * @returns Unsubscribe function to remove the handler
   */
  onConnect(handler: ConnectionHandler): () => void {
    this.connectionHandlers.add(handler);
    return () => this.connectionHandlers.delete(handler);
  }

  /**
   * Registers a handler for disconnection events.
   *
   * @param handler - Function to call when disconnected
   * @returns Unsubscribe function to remove the handler
   */
  onDisconnect(handler: ConnectionHandler): () => void {
    this.disconnectionHandlers.add(handler);
    return () => this.disconnectionHandlers.delete(handler);
  }

  /** Whether the WebSocket is currently connected and open */
  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** The unique client ID assigned by the server */
  get currentClientId(): string | null {
    return this.clientId;
  }
}

/** Singleton WebSocket service instance for the application */
export const wsService = new WebSocketService();
