import { WebSocketMessage } from '../types';

/**
 * Callback function type for handling WebSocket messages.
 * @param message - The parsed WebSocket message
 */
type MessageHandler = (message: WebSocketMessage) => void;

/**
 * WebSocket service for real-time communication between frontend and backend.
 * Enables instant ride offers to drivers, live location tracking, and status updates.
 * Using WebSocket instead of polling reduces latency from seconds to milliseconds.
 *
 * Features:
 * - Automatic reconnection with exponential backoff
 * - Type-based message routing with subscribe/unsubscribe pattern
 * - Wildcard handlers for debugging or logging all messages
 */
class WebSocketService {
  /** Active WebSocket connection instance */
  private ws: WebSocket | null = null;

  /** Message handlers organized by message type */
  private handlers: Map<string, Set<MessageHandler>> = new Map();

  /** Current reconnection attempt count */
  private reconnectAttempts = 0;

  /** Maximum number of reconnection attempts before giving up */
  private maxReconnectAttempts = 5;

  /** Base delay between reconnection attempts in milliseconds */
  private reconnectDelay = 1000;

  /**
   * Establish WebSocket connection and authenticate.
   * Connection URL is derived from current page location to work with Vite proxy.
   *
   * @param token - JWT token for authentication
   * @returns Promise that resolves when connection is established
   */
  connect(token: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const wsUrl = `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws`;

      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        console.log('WebSocket connected');
        this.reconnectAttempts = 0;

        // Authenticate immediately after connection
        this.send({ type: 'auth', token });
        resolve();
      };

      this.ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data) as WebSocketMessage;
          this.handleMessage(message);
        } catch (error) {
          console.error('Failed to parse WebSocket message:', error);
        }
      };

      this.ws.onclose = () => {
        console.log('WebSocket disconnected');
        this.attemptReconnect(token);
      };

      this.ws.onerror = (error) => {
        console.error('WebSocket error:', error);
        reject(error);
      };
    });
  }

  /**
   * Attempt to reconnect with exponential backoff.
   * Delay increases with each attempt to avoid overwhelming the server.
   *
   * @param token - JWT token for re-authentication
   */
  private attemptReconnect(token: string) {
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      console.log(`Attempting to reconnect (${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);

      setTimeout(() => {
        this.connect(token).catch(console.error);
      }, this.reconnectDelay * this.reconnectAttempts);
    }
  }

  /**
   * Close WebSocket connection and clear all handlers.
   * Called on user logout to clean up resources.
   */
  disconnect() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.handlers.clear();
  }

  /**
   * Send a message through the WebSocket connection.
   * Silently fails if connection is not open.
   *
   * @param message - Message object to send (will be JSON stringified)
   */
  send(message: unknown) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  /**
   * Subscribe to messages of a specific type.
   * Use '*' as type to receive all messages (useful for debugging).
   *
   * @param type - Message type to listen for (e.g., 'ride_offer', 'driver_arrived')
   * @param handler - Callback function to invoke when message is received
   */
  on(type: string, handler: MessageHandler) {
    if (!this.handlers.has(type)) {
      this.handlers.set(type, new Set());
    }
    this.handlers.get(type)!.add(handler);
  }

  /**
   * Unsubscribe from messages of a specific type.
   *
   * @param type - Message type to stop listening for
   * @param handler - The exact handler function that was registered
   */
  off(type: string, handler: MessageHandler) {
    const handlers = this.handlers.get(type);
    if (handlers) {
      handlers.delete(handler);
    }
  }

  /**
   * Route incoming message to appropriate handlers.
   * Invokes both type-specific handlers and wildcard ('*') handlers.
   *
   * @param message - Parsed WebSocket message
   */
  private handleMessage(message: WebSocketMessage) {
    const handlers = this.handlers.get(message.type);
    if (handlers) {
      handlers.forEach((handler) => handler(message));
    }

    // Also call wildcard handlers for debugging/logging
    const allHandlers = this.handlers.get('*');
    if (allHandlers) {
      allHandlers.forEach((handler) => handler(message));
    }
  }

  /**
   * Send driver location update to server.
   * Called periodically while driver is online for real-time tracking.
   *
   * @param lat - Current latitude
   * @param lng - Current longitude
   */
  sendLocationUpdate(lat: number, lng: number) {
    this.send({ type: 'location_update', lat, lng });
  }

  /**
   * Send ping message to keep connection alive.
   * Prevents connection timeout on idle connections.
   */
  ping() {
    this.send({ type: 'ping' });
  }
}

/**
 * Singleton WebSocket service instance.
 * Shared across all components that need real-time updates.
 */
export const wsService = new WebSocketService();
export default wsService;
