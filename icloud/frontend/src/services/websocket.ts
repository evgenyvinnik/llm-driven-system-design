import type { WSMessage, WSFileEvent, WSPhotoEvent } from '../types';

/**
 * Handler function type for WebSocket message events.
 * @param message - The parsed WebSocket message
 */
type MessageHandler = (message: WSMessage) => void;

/**
 * WebSocket client for real-time sync notifications.
 *
 * This service maintains a persistent WebSocket connection to the server
 * to receive real-time updates when files or photos are modified on other
 * devices. It handles automatic reconnection with exponential backoff and
 * provides a pub/sub interface for subscribing to specific event types.
 *
 * Key features:
 * - Automatic reconnection with exponential backoff
 * - Event-based subscription model
 * - Wildcard subscriptions for all events
 * - File-specific subscription for collaborative editing
 */
class WebSocketService {
  /** The underlying WebSocket connection */
  private ws: WebSocket | null = null;
  /** Map of event types to their registered handlers */
  private handlers: Map<string, Set<MessageHandler>> = new Map();
  /** Current reconnection attempt count */
  private reconnectAttempts = 0;
  /** Maximum reconnection attempts before giving up */
  private maxReconnectAttempts = 5;
  /** Base delay for reconnection (doubles with each attempt) */
  private reconnectDelay = 1000;
  /** Whether the app wants a connection (false after logout) */
  private active = false;

  /**
   * Opens the WebSocket connection for the logged-in user.
   *
   * The server authenticates the upgrade request with the httpOnly
   * `session_token` cookie, which the browser sends automatically, so no
   * token is passed in the URL. Safe to call again while already connected.
   */
  connect() {
    this.active = true;
    this.reconnectAttempts = 0;
    if (
      this.ws &&
      (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }
    this.doConnect();
  }

  /**
   * Internal method that performs the actual WebSocket connection.
   *
   * Sets up event handlers for open, message, close, and error events.
   * Automatically selects ws:// or wss:// based on the current page protocol.
   */
  private doConnect() {
    if (!this.active) return;

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    const wsUrl = `${protocol}//${host}/ws`;

    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      console.log('WebSocket connected');
      this.reconnectAttempts = 0;
      this.emit('connected', { type: 'connected' });
    };

    this.ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data) as WSMessage;
        this.emit(message.type, message);
        this.emit('*', message); // Wildcard for all messages
      } catch (error) {
        console.error('Failed to parse WebSocket message:', error);
      }
    };

    this.ws.onclose = (event) => {
      console.log('WebSocket closed:', event.code, event.reason);
      this.emit('disconnected', { type: 'disconnected' });
      this.handleReconnect();
    };

    this.ws.onerror = (error) => {
      console.error('WebSocket error:', error);
      this.emit('error', { type: 'error', error });
    };
  }

  /**
   * Handles reconnection logic with exponential backoff.
   *
   * Doubles the delay between each reconnection attempt to avoid
   * overwhelming the server. Gives up after maxReconnectAttempts.
   */
  private handleReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.log('Max reconnect attempts reached');
      return;
    }

    this.reconnectAttempts++;
    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);

    console.log(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);

    setTimeout(() => {
      this.doConnect();
    }, delay);
  }

  /**
   * Closes the WebSocket connection and prevents reconnection.
   *
   * Should be called on logout or when the user leaves the application.
   * Marks the service inactive and sets reconnect attempts to max to prevent
   * automatic reconnection.
   */
  disconnect() {
    this.active = false;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.reconnectAttempts = this.maxReconnectAttempts; // Prevent reconnection
  }

  /**
   * Sends a message to the server over the WebSocket connection.
   *
   * Messages are JSON-serialized before sending. Silently fails if the
   * connection is not open (messages are not queued).
   *
   * @param message - Object to send as JSON
   */
  send(message: object) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  /**
   * Registers a handler for a specific event type.
   *
   * Use '*' as the type to receive all events (wildcard subscription).
   * Multiple handlers can be registered for the same event type.
   *
   * @param type - Event type to listen for (or '*' for all)
   * @param handler - Callback function to invoke when event occurs
   */
  on(type: string, handler: MessageHandler) {
    if (!this.handlers.has(type)) {
      this.handlers.set(type, new Set());
    }
    this.handlers.get(type)!.add(handler);
  }

  /**
   * Unregisters a previously registered event handler.
   *
   * @param type - Event type the handler was registered for
   * @param handler - The handler function to remove
   */
  off(type: string, handler: MessageHandler) {
    this.handlers.get(type)?.delete(handler);
  }

  /**
   * Emits an event to all registered handlers.
   *
   * Internal method used to dispatch parsed messages to subscribers.
   * Catches and logs errors from handlers to prevent one bad handler
   * from breaking others.
   *
   * @param type - Event type to emit
   * @param message - Message payload to pass to handlers
   */
  private emit(type: string, message: WSMessage) {
    this.handlers.get(type)?.forEach((handler) => {
      try {
        handler(message);
      } catch (error) {
        console.error('Error in WebSocket handler:', error);
      }
    });
  }

  /**
   * Subscribes to real-time updates for a specific file.
   *
   * Used for collaborative editing or watching important files.
   * The server will send granular change notifications for this file.
   *
   * @param fileId - ID of the file to watch
   */
  subscribeToFile(fileId: string) {
    this.send({ type: 'subscribe', data: { fileId } });
  }

  /**
   * Unsubscribes from updates for a specific file.
   *
   * @param fileId - ID of the file to stop watching
   */
  unsubscribeFromFile(fileId: string) {
    this.send({ type: 'unsubscribe', data: { fileId } });
  }

  /**
   * Requests an immediate sync operation.
   *
   * Tells the server to push any pending changes to this device.
   * Useful after reconnecting or when the user manually triggers refresh.
   */
  requestSync() {
    this.send({ type: 'sync_request' });
  }

  /**
   * Indicates whether the WebSocket connection is currently open.
   *
   * @returns true if connected and ready to send/receive messages
   */
  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}

/**
 * Singleton WebSocket service instance.
 *
 * Use this exported instance throughout the application to maintain
 * a single connection per browser tab.
 */
export const wsService = new WebSocketService();

/**
 * Type guard to check if a WebSocket message is a file-related event.
 *
 * File events are emitted when files are created, updated, or deleted
 * on another device and need to be synced locally.
 *
 * @param message - The WebSocket message to check
 * @returns true if the message is a file creation, update, or deletion event
 */
export function isFileEvent(message: WSMessage): message is WSFileEvent {
  return ['file_created', 'file_updated', 'file_deleted'].includes(message.type);
}

/**
 * Type guard to check if a WebSocket message is a photo-related event.
 *
 * Photo events are emitted when photos are added, updated, or deleted
 * on another device and need to be synced locally.
 *
 * @param message - The WebSocket message to check
 * @returns true if the message is a photo add, update, or deletion event
 */
export function isPhotoEvent(message: WSMessage): message is WSPhotoEvent {
  return ['photo_added', 'photo_updated', 'photo_deleted'].includes(message.type);
}
