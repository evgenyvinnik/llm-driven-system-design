/**
 * WebSocket client service for real-time communication.
 * Handles connection management, authentication, message routing, and reconnection.
 */

/** Generic WebSocket message structure with type discriminator */
type WebSocketMessage = {
  type: string;
  [key: string]: unknown;
};

/** Handler function for processing incoming WebSocket messages */
type MessageHandler = (message: WebSocketMessage) => void;

/**
 * Singleton WebSocket service that manages the client-side WebSocket connection.
 * Provides event-based message handling with automatic reconnection.
 */
class WebSocketService {
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectDelay = 1000;
  /** Map of message type to array of handler functions */
  private handlers: Map<string, MessageHandler[]> = new Map();
  private userId: string | null = null;
  private isConnecting = false;

  /**
   * Establishes WebSocket connection and authenticates with the server.
   * @param userId - User ID to authenticate with
   */
  connect(userId: string): void {
    if (this.ws?.readyState === WebSocket.OPEN || this.isConnecting) {
      return;
    }

    this.userId = userId;
    this.isConnecting = true;

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;

    try {
      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        console.log('WebSocket connected');
        this.isConnecting = false;
        this.reconnectAttempts = 0;

        // Authenticate
        this.send({ type: 'auth', userId });
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
        this.isConnecting = false;
        this.attemptReconnect();
      };

      this.ws.onerror = (error) => {
        console.error('WebSocket error:', error);
        this.isConnecting = false;
      };
    } catch (error) {
      console.error('Failed to connect WebSocket:', error);
      this.isConnecting = false;
    }
  }

  /**
   * Closes the WebSocket connection and resets state.
   */
  disconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.userId = null;
    this.reconnectAttempts = 0;
  }

  /**
   * Attempts to reconnect with exponential backoff.
   * Stops after maxReconnectAttempts.
   */
  private attemptReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts || !this.userId) {
      return;
    }

    this.reconnectAttempts++;
    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);

    console.log(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);

    setTimeout(() => {
      if (this.userId) {
        this.connect(this.userId);
      }
    }, delay);
  }

  /**
   * Sends a message through the WebSocket connection.
   * @param message - Message object to send (will be JSON stringified)
   */
  send(message: WebSocketMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  /**
   * Dispatches incoming message to registered handlers.
   * @param message - Parsed message from server
   */
  private handleMessage(message: WebSocketMessage): void {
    const handlers = this.handlers.get(message.type) || [];
    handlers.forEach((handler) => handler(message));

    // Also call 'all' handlers
    const allHandlers = this.handlers.get('all') || [];
    allHandlers.forEach((handler) => handler(message));
  }

  /**
   * Registers a handler for a specific message type.
   * @param type - Message type to listen for (or 'all' for all messages)
   * @param handler - Function to call when message is received
   * @returns Unsubscribe function to remove the handler
   */
  on(type: string, handler: MessageHandler): () => void {
    const handlers = this.handlers.get(type) || [];
    handlers.push(handler);
    this.handlers.set(type, handlers);

    // Return unsubscribe function
    return () => {
      const currentHandlers = this.handlers.get(type) || [];
      const index = currentHandlers.indexOf(handler);
      if (index > -1) {
        currentHandlers.splice(index, 1);
        this.handlers.set(type, currentHandlers);
      }
    };
  }

  /**
   * Removes a handler for a specific message type.
   * @param type - Message type to remove handler from
   * @param handler - Specific handler to remove (or undefined to remove all)
   */
  off(type: string, handler?: MessageHandler): void {
    if (handler) {
      const handlers = this.handlers.get(type) || [];
      const index = handlers.indexOf(handler);
      if (index > -1) {
        handlers.splice(index, 1);
        this.handlers.set(type, handlers);
      }
    } else {
      this.handlers.delete(type);
    }
  }

  /**
   * Sends a typing indicator to another user in a match.
   * @param matchId - The match conversation ID
   * @param recipientId - The user to notify about typing
   */
  sendTyping(matchId: string, recipientId: string): void {
    this.send({
      type: 'typing',
      matchId,
      recipientId,
    });
  }

  /**
   * Checks if the WebSocket connection is currently open.
   * @returns True if connected, false otherwise
   */
  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}

/** Singleton instance of the WebSocket service for use across the application */
export const wsService = new WebSocketService();
