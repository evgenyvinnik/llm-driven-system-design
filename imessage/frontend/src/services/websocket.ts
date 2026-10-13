import type { ConnectionStatus, WebSocketMessage } from '@/types';

/**
 * Callback function type for handling incoming WebSocket messages.
 * @param message - The parsed WebSocket message object
 */
type MessageHandler = (message: WebSocketMessage) => void;
type StatusHandler = (status: ConnectionStatus) => void;

const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 30_000;

/** Close codes after which reconnecting cannot help (bad token, revoked device). */
const TERMINAL_CLOSE_CODES = new Set([4001, 4003]);

/**
 * WebSocket service for real-time messaging.
 *
 * Responsibilities: one connection per tab, reconnection with capped
 * exponential backoff plus jitter (forever - a messaging app must come back
 * after any outage), an outbox for frames sent while disconnected, and a
 * connection status the UI can show.
 *
 * Delivery guarantees do not depend on this socket staying up. The server
 * keeps every message in this device's inbox until the device acks it, and
 * pushes the backlog when the socket (re)connects; sends are idempotent by
 * clientMessageId, so replaying the outbox cannot duplicate a message.
 */
class WebSocketService {
  private ws: WebSocket | null = null;
  private token: string | null = null;
  private handlers: Set<MessageHandler> = new Set();
  private statusHandlers: Set<StatusHandler> = new Set();
  private status: ConnectionStatus = 'closed';
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** Frames sent while disconnected, flushed in order when the socket opens */
  private outbox: WebSocketMessage[] = [];
  /** Set by disconnect(): an intentional close must not trigger reconnects */
  private closedByClient = true;

  constructor() {
    if (typeof window === 'undefined') return;
    // The network came back or the tab woke up: skip the remaining backoff
    window.addEventListener('online', () => this.reconnectNow());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      if (this.ws?.readyState === WebSocket.OPEN) {
        // Cheap catch-up in case a push was missed while the tab was asleep
        this.requestSync();
      } else {
        this.reconnectNow();
      }
    });
  }

  /**
   * Opens the connection (idempotent while one is open or opening).
   * @param token - Session token for the connection
   */
  connect(token: string): void {
    this.token = token;
    this.closedByClient = false;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    this.open();
  }

  private open(): void {
    if (!this.token) return;

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws?token=${encodeURIComponent(this.token)}`);
    this.ws = ws;
    this.setStatus(this.reconnectAttempts > 0 ? 'reconnecting' : 'connecting');

    ws.onopen = () => {
      this.reconnectAttempts = 0;
      this.setStatus('open');
      // The server processes frames in arrival order, after authentication
      for (const frame of this.outbox.splice(0)) {
        ws.send(JSON.stringify(frame));
      }
    };

    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data) as WebSocketMessage;
        this.handlers.forEach((handler) => handler(message));
      } catch (error) {
        console.error('Failed to parse WebSocket message:', error);
      }
    };

    ws.onclose = (event) => {
      if (this.ws !== ws) return; // superseded by a newer socket
      this.ws = null;
      if (this.closedByClient || TERMINAL_CLOSE_CODES.has(event.code)) {
        this.setStatus('closed');
        return;
      }
      this.scheduleReconnect();
    };

    ws.onerror = () => {
      // onclose always follows and owns reconnection
    };
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.closedByClient) return;
    this.reconnectAttempts++;
    const ceiling = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** (this.reconnectAttempts - 1));
    // Jitter spreads out thousands of clients reconnecting after a server restart
    const delay = Math.round(ceiling / 2 + Math.random() * (ceiling / 2));
    this.setStatus('reconnecting');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, delay);
  }

  private reconnectNow(): void {
    if (this.closedByClient || !this.token || this.ws) return;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.open();
  }

  /**
   * Closes the connection on logout. Subscribers stay registered: they belong
   * to long-lived components, and clearing them here used to leave a
   * re-logged-in tab without any real-time updates.
   */
  disconnect(): void {
    this.closedByClient = true;
    this.token = null;
    this.outbox = [];
    this.reconnectAttempts = 0;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const ws = this.ws;
    this.ws = null;
    ws?.close(1000, 'Logged out');
    this.setStatus('closed');
  }

  /**
   * Sends a frame, or queues it until the socket opens. Typing indicators are
   * dropped instead of queued - they are worthless once stale.
   */
  send(message: WebSocketMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    } else if (message.type !== 'typing') {
      this.outbox.push(message);
    }
  }

  /**
   * Registers a handler function for incoming WebSocket messages.
   * @returns Unsubscribe function to remove the handler
   */
  subscribe(handler: MessageHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  /** Registers a listener for connection status changes. */
  subscribeStatus(handler: StatusHandler): () => void {
    this.statusHandlers.add(handler);
    return () => {
      this.statusHandlers.delete(handler);
    };
  }

  getStatus(): ConnectionStatus {
    return this.status;
  }

  private setStatus(status: ConnectionStatus): void {
    if (status === this.status) return;
    this.status = status;
    this.statusHandlers.forEach((handler) => handler(status));
  }

  // Convenience methods

  /**
   * Sends a chat message. The clientMessageId is generated once per message
   * and reused for every retry, which is what makes retries safe.
   */
  sendMessage(
    conversationId: string,
    content: string,
    options: { clientMessageId: string; contentType?: string; replyToId?: string }
  ) {
    this.send({
      type: 'send_message',
      conversationId,
      content,
      ...options,
    });
  }

  /** Sends a typing indicator to a conversation. */
  sendTyping(conversationId: string, isTyping: boolean) {
    this.send({
      type: 'typing',
      conversationId,
      isTyping,
    });
  }

  /** Advances this device's read watermark to the given message. */
  sendRead(conversationId: string, messageId: string) {
    this.send({
      type: 'read',
      conversationId,
      messageId,
    });
  }

  /** Sends a reaction (emoji) to a message, or removes it. */
  sendReaction(messageId: string, reaction: string, remove = false) {
    this.send({
      type: 'reaction',
      messageId,
      reaction,
      remove,
    });
  }

  /** Acknowledges received messages so the server can drop them from this device's inbox. */
  sendAck(messageIds: string[]) {
    if (messageIds.length === 0) return;
    this.send({ type: 'ack', messageIds });
  }

  /** Asks the server for the next batch of this device's undelivered messages. */
  requestSync() {
    this.send({ type: 'sync' });
  }

  /** True if connected and ready to send/receive messages */
  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}

/**
 * Singleton instance of the WebSocket service.
 * Use this throughout the application for real-time messaging.
 */
export const wsService = new WebSocketService();
