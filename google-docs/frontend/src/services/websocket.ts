import type { WSMessage, PresenceState, Operation, DocumentContent } from '../types';

type MessageHandler = (message: WSMessage) => void;

class WebSocketService {
  private ws: WebSocket | null = null;
  private token: string | null = null;
  private documentId: string | null = null;
  private messageHandlers: Set<MessageHandler> = new Set();
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectDelay = 1000;
  private pendingOperations: Array<{ operation: Operation[]; version: number }> = [];
  private isConnecting = false;

  setToken(token: string | null) {
    this.token = token;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        resolve();
        return;
      }

      if (this.isConnecting) {
        resolve();
        return;
      }

      if (!this.token) {
        reject(new Error('No token set'));
        return;
      }

      this.isConnecting = true;

      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const host = window.location.host;
      const url = `${protocol}//${host}/ws?token=${this.token}`;

      this.ws = new WebSocket(url);

      this.ws.onopen = () => {
        console.log('WebSocket connected');
        this.isConnecting = false;
        this.reconnectAttempts = 0;

        // Resubscribe to document if we were in one
        if (this.documentId) {
          this.subscribe(this.documentId);
        }

        resolve();
      };

      this.ws.onclose = (event) => {
        console.log('WebSocket closed:', event.code, event.reason);
        this.isConnecting = false;

        if (this.reconnectAttempts < this.maxReconnectAttempts) {
          this.reconnectAttempts++;
          setTimeout(() => {
            this.connect().catch(console.error);
          }, this.reconnectDelay * this.reconnectAttempts);
        }
      };

      this.ws.onerror = (error) => {
        console.error('WebSocket error:', error);
        this.isConnecting = false;
        reject(error);
      };

      this.ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data) as WSMessage;
          this.handleMessage(message);
        } catch (error) {
          console.error('Failed to parse WebSocket message:', error);
        }
      };
    });
  }

  disconnect() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.documentId = null;
    this.pendingOperations = [];
  }

  subscribe(documentId: string) {
    this.documentId = documentId;
    this.send({ type: 'SUBSCRIBE', doc_id: documentId });
  }

  unsubscribe() {
    if (this.documentId) {
      this.send({ type: 'UNSUBSCRIBE', doc_id: this.documentId });
      this.documentId = null;
    }
  }

  sendOperation(operation: Operation[], version: number) {
    this.pendingOperations.push({ operation, version });
    this.send({
      type: 'OPERATION',
      doc_id: this.documentId!,
      version,
      operation,
    });
  }

  sendCursor(position: number) {
    this.send({
      type: 'CURSOR',
      doc_id: this.documentId!,
      cursor: { position },
    });
  }

  sendSelection(start: number, end: number) {
    this.send({
      type: 'CURSOR',
      doc_id: this.documentId!,
      selection: { start, end },
    });
  }

  private send(message: WSMessage) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  private handleMessage(message: WSMessage) {
    // Handle ACK to remove pending operations
    if (message.type === 'ACK') {
      const index = this.pendingOperations.findIndex(
        (op) => op.version < (message.version || 0)
      );
      if (index >= 0) {
        this.pendingOperations.splice(0, index + 1);
      }
    }

    // Notify all handlers
    this.messageHandlers.forEach((handler) => handler(message));
  }

  addMessageHandler(handler: MessageHandler) {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  getCurrentDocumentId(): string | null {
    return this.documentId;
  }
}

export const wsService = new WebSocketService();
export default wsService;
