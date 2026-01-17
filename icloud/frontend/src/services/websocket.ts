import type { WSMessage, WSFileEvent, WSPhotoEvent } from '../types';

type MessageHandler = (message: WSMessage) => void;

class WebSocketService {
  private ws: WebSocket | null = null;
  private handlers: Map<string, Set<MessageHandler>> = new Map();
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectDelay = 1000;
  private token: string | null = null;

  connect(token: string) {
    this.token = token;
    this.doConnect();
  }

  private doConnect() {
    if (!this.token) return;

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    const wsUrl = `${protocol}//${host}/ws?token=${this.token}`;

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

  disconnect() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.token = null;
    this.reconnectAttempts = this.maxReconnectAttempts; // Prevent reconnection
  }

  send(message: object) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  on(type: string, handler: MessageHandler) {
    if (!this.handlers.has(type)) {
      this.handlers.set(type, new Set());
    }
    this.handlers.get(type)!.add(handler);
  }

  off(type: string, handler: MessageHandler) {
    this.handlers.get(type)?.delete(handler);
  }

  private emit(type: string, message: WSMessage) {
    this.handlers.get(type)?.forEach((handler) => {
      try {
        handler(message);
      } catch (error) {
        console.error('Error in WebSocket handler:', error);
      }
    });
  }

  // Subscribe to file changes
  subscribeToFile(fileId: string) {
    this.send({ type: 'subscribe', data: { fileId } });
  }

  unsubscribeFromFile(fileId: string) {
    this.send({ type: 'unsubscribe', data: { fileId } });
  }

  // Request sync
  requestSync() {
    this.send({ type: 'sync_request' });
  }

  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}

export const wsService = new WebSocketService();

// Type guards
export function isFileEvent(message: WSMessage): message is WSFileEvent {
  return ['file_created', 'file_updated', 'file_deleted'].includes(message.type);
}

export function isPhotoEvent(message: WSMessage): message is WSPhotoEvent {
  return ['photo_added', 'photo_updated', 'photo_deleted'].includes(message.type);
}
