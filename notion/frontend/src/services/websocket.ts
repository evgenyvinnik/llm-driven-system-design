/**
 * @fileoverview WebSocket client for real-time collaboration.
 *
 * The socket only RECEIVES committed changes; edits are saved over REST. The
 * client remembers which page it is subscribed to and, after every
 * (re)connect, subscribes again with the last operation seq the editor applied,
 * so the server replays exactly what was missed while the connection was down.
 * Reconnects never give up (capped exponential backoff with jitter), and a
 * watchdog reconnects when the server's 30-second heartbeat stops arriving.
 */

import type { WSMessage } from '@/types';

/** Handler function for incoming WebSocket messages */
type MessageHandler = (message: WSMessage) => void;

/** Handler function for connection state changes */
type ConnectionHandler = () => void;

/** No message (not even a heartbeat) for this long means the link is dead. */
const SILENCE_TIMEOUT_MS = 75_000;
const MAX_BACKOFF_MS = 30_000;

/**
 * WebSocket service for real-time communication with the server.
 */
class WebSocketService {
  private ws: WebSocket | null = null;
  private token: string | null = null;
  private shouldReconnect = false;
  private reconnectAttempts = 0;
  private reconnectTimer: number | null = null;
  private watchdogTimer: number | null = null;
  private lastMessageAt = 0;
  private subscription: { pageId: string; sinceSeq: () => number } | null = null;
  private messageHandlers: Set<MessageHandler> = new Set();
  private connectionHandlers: Set<ConnectionHandler> = new Set();
  private disconnectionHandlers: Set<ConnectionHandler> = new Set();
  private clientId: string | null = null;

  constructor() {
    if (typeof window !== 'undefined') {
      // Coming back online: reconnect now instead of waiting out the backoff.
      window.addEventListener('online', () => {
        if (this.shouldReconnect && !this.ws && this.token) {
          this.reconnectAttempts = 0;
          this.connect(this.token);
        }
      });
    }
  }

  /**
   * Establishes a WebSocket connection with the server.
   *
   * @param token - Session token for authentication
   */
  connect(token: string): void {
    this.token = token;
    this.shouldReconnect = true;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws?token=${encodeURIComponent(token)}`);
    this.ws = ws;

    ws.onopen = () => {
      this.reconnectAttempts = 0;
      this.lastMessageAt = Date.now();
      this.startWatchdog();
      // Resume the page subscription from the last seq the editor applied.
      if (this.subscription) {
        this.sendNow({
          type: 'subscribe',
          payload: { pageId: this.subscription.pageId, sinceSeq: this.subscription.sinceSeq() },
        });
      }
      this.connectionHandlers.forEach((handler) => handler());
    };

    ws.onmessage = (event) => {
      this.lastMessageAt = Date.now();
      try {
        const message: WSMessage = JSON.parse(event.data);
        if (message.type === 'connected') {
          this.clientId = (message.payload as { clientId: string }).clientId;
        }
        this.messageHandlers.forEach((handler) => handler(message));
      } catch (error) {
        console.error('Failed to parse WebSocket message:', error);
      }
    };

    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.clientId = null;
      this.stopWatchdog();
      this.disconnectionHandlers.forEach((handler) => handler());
      if (this.shouldReconnect) this.scheduleReconnect();
    };

    ws.onerror = () => {
      // onclose follows and schedules the reconnect.
    };
  }

  /**
   * Closes the connection and stops reconnecting (logout).
   */
  disconnect(): void {
    this.shouldReconnect = false;
    this.subscription = null;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopWatchdog();
    const ws = this.ws;
    this.ws = null;
    this.clientId = null;
    ws?.close();
  }

  private scheduleReconnect(): void {
    const base = Math.min(1000 * 2 ** this.reconnectAttempts, MAX_BACKOFF_MS);
    const delay = base / 2 + Math.random() * (base / 2);
    this.reconnectAttempts++;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      if (this.shouldReconnect && this.token) this.connect(this.token);
    }, delay);
  }

  private startWatchdog(): void {
    this.stopWatchdog();
    this.watchdogTimer = window.setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN && Date.now() - this.lastMessageAt > SILENCE_TIMEOUT_MS) {
        this.ws.close(); // onclose schedules the reconnect
      }
    }, 10_000);
  }

  private stopWatchdog(): void {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  /** Sends now if connected; otherwise drops the message (state is resent on reconnect). */
  private sendNow(message: WSMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  /**
   * Subscribes to a page. `sinceSeq` is read at send time, so a reconnect
   * resumes from whatever the editor has applied by then.
   *
   * @param pageId - The page to subscribe to
   * @param sinceSeq - Returns the last operation seq the editor applied
   */
  subscribePage(pageId: string, sinceSeq: () => number): void {
    this.subscription = { pageId, sinceSeq };
    this.sendNow({ type: 'subscribe', payload: { pageId, sinceSeq: sinceSeq() } });
  }

  /**
   * Unsubscribes from the current page.
   */
  unsubscribePage(): void {
    this.subscription = null;
    this.sendNow({ type: 'unsubscribe', payload: {} });
  }

  /**
   * Asks the server to replay operations after `sinceSeq` (gap detected).
   */
  requestSync(pageId: string, sinceSeq: number): void {
    this.sendNow({ type: 'sync', payload: { pageId, sinceSeq } });
  }

  /**
   * Updates the user's cursor position for presence display.
   *
   * @param cursorPosition - The current cursor location (block and offset)
   */
  updatePresence(cursorPosition?: { block_id: string; offset: number }): void {
    this.sendNow({ type: 'presence', payload: { cursor_position: cursorPosition } });
  }

  /**
   * Registers a handler for incoming WebSocket messages.
   *
   * @returns Unsubscribe function to remove the handler
   */
  onMessage(handler: MessageHandler): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  /**
   * Registers a handler for successful connection events.
   *
   * @returns Unsubscribe function to remove the handler
   */
  onConnect(handler: ConnectionHandler): () => void {
    this.connectionHandlers.add(handler);
    return () => this.connectionHandlers.delete(handler);
  }

  /**
   * Registers a handler for disconnection events.
   *
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
