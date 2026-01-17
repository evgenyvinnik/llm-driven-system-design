import type { Presence, WSMessage, Operation } from '@/types';

type MessageHandler = (message: WSMessage) => void;
type ConnectionHandler = () => void;

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

  send(message: WSMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    } else {
      this.pendingMessages.push(message);
    }
  }

  // Subscribe to a page for real-time updates
  subscribePage(pageId: string): void {
    this.send({
      type: 'subscribe',
      payload: { pageId },
    });
  }

  // Unsubscribe from current page
  unsubscribePage(): void {
    this.send({
      type: 'unsubscribe',
      payload: {},
    });
  }

  // Send an operation
  sendOperation(operation: Omit<Operation, 'timestamp' | 'author_id'>): void {
    this.send({
      type: 'operation',
      payload: operation,
    });
  }

  // Update presence (cursor position)
  updatePresence(cursorPosition?: { block_id: string; offset: number }): void {
    this.send({
      type: 'presence',
      payload: { cursor_position: cursorPosition },
    });
  }

  // Request sync from a specific timestamp
  requestSync(since: number): void {
    this.send({
      type: 'sync',
      payload: { since },
    });
  }

  // Event handlers
  onMessage(handler: MessageHandler): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  onConnect(handler: ConnectionHandler): () => void {
    this.connectionHandlers.add(handler);
    return () => this.connectionHandlers.delete(handler);
  }

  onDisconnect(handler: ConnectionHandler): () => void {
    this.disconnectionHandlers.add(handler);
    return () => this.disconnectionHandlers.delete(handler);
  }

  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  get currentClientId(): string | null {
    return this.clientId;
  }
}

export const wsService = new WebSocketService();
