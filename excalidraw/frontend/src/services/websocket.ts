import type { ExcalidrawElement } from '../types';

export type WsMessageHandler = (message: WsMessage) => void;

export interface WsMessage {
  type: string;
  drawingId?: string;
  clientId?: string;
  userId?: string | null;
  canEdit?: boolean;
  code?: string;
  reason?: string;
  username?: string;
  elementId?: string;
  elementData?: ExcalidrawElement;
  elements?: ExcalidrawElement[];
  x?: number;
  y?: number;
  color?: string;
  message?: string;
}

/** WebSocket client for real-time drawing collaboration with auto-reconnect. */
class WebSocketClient {
  private ws: WebSocket | null = null;
  private handlers: Map<string, WsMessageHandler[]> = new Map();
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectDelay = 1000;
  private drawingId: string | null = null;
  private clientId: string | null = null;
  private assignedColor: string = '#6965db';
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Opens the socket if there isn't one. Identity is not sent by the client:
   * the server reads it from the session cookie during the upgrade.
   */
  connect(): void {
    if (this.ws?.readyState === WebSocket.OPEN || this.ws?.readyState === WebSocket.CONNECTING) return;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    const socket = new WebSocket(`${protocol}//${host}/ws`);
    this.ws = socket;

    socket.onopen = () => {
      this.reconnectAttempts = 0;

      // Re-join the room we were in
      if (this.drawingId) {
        this.send({ type: 'join-room', drawingId: this.drawingId });
      }
    };

    socket.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data) as WsMessage;

        if (message.type === 'connected') {
          if (message.color) this.assignedColor = message.color;
          this.clientId = message.clientId ?? null;
        }

        const handlers = this.handlers.get(message.type) || [];
        for (const handler of handlers) {
          handler(message);
        }

        // Also fire catch-all handlers
        const allHandlers = this.handlers.get('*') || [];
        for (const handler of allHandlers) {
          handler(message);
        }
      } catch {
        // Ignore malformed messages
      }
    };

    socket.onclose = () => {
      // A socket that was replaced or deliberately closed must not reconnect.
      if (this.ws !== socket) return;
      if (this.reconnectAttempts < this.maxReconnectAttempts) {
        const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts);
        this.reconnectAttempts++;
        this.reconnectTimer = setTimeout(() => this.connect(), delay);
      }
    };

    socket.onerror = () => {
      // Error handling is done in onclose
    };
  }

  /** Reopens the socket, e.g. after login or logout changes the session identity. */
  reconnect(): void {
    const previous = this.ws;
    this.ws = null;
    previous?.close();
    this.reconnectAttempts = 0;
    this.connect();
  }

  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const previous = this.ws;
    this.ws = null;
    previous?.close();
  }

  send(message: WsMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  on(type: string, handler: WsMessageHandler): () => void {
    if (!this.handlers.has(type)) {
      this.handlers.set(type, []);
    }
    this.handlers.get(type)!.push(handler);

    // Return unsubscribe function
    return () => {
      const handlers = this.handlers.get(type);
      if (handlers) {
        const index = handlers.indexOf(handler);
        if (index >= 0) {
          handlers.splice(index, 1);
        }
      }
    };
  }

  off(type: string, handler: WsMessageHandler): void {
    const handlers = this.handlers.get(type);
    if (handlers) {
      const index = handlers.indexOf(handler);
      if (index >= 0) {
        handlers.splice(index, 1);
      }
    }
  }

  /** Joins a drawing now, or as soon as the socket opens. */
  joinRoom(drawingId: string): void {
    this.drawingId = drawingId;
    this.send({ type: 'join-room', drawingId });
  }

  leaveRoom(): void {
    if (this.drawingId) {
      this.send({ type: 'leave-room' });
      this.drawingId = null;
    }
  }

  sendShapeAdd(element: ExcalidrawElement): void {
    this.send({
      type: 'shape-add',
      elementData: element,
    });
  }

  sendShapeUpdate(element: ExcalidrawElement): void {
    this.send({
      type: 'shape-update',
      elementData: element,
    });
  }

  sendShapeDelete(elementId: string): void {
    this.send({
      type: 'shape-delete',
      elementId,
    });
  }

  sendShapeMove(element: ExcalidrawElement): void {
    this.send({
      type: 'shape-move',
      elementData: element,
    });
  }

  sendCursorMove(x: number, y: number): void {
    this.send({
      type: 'cursor-move',
      x,
      y,
    });
  }

  sendElementsSync(elements: ExcalidrawElement[]): void {
    this.send({
      type: 'elements-sync',
      elements,
    });
  }

  getColor(): string {
    return this.assignedColor;
  }

  getClientId(): string | null {
    return this.clientId;
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}

// Singleton instance
export const wsClient = new WebSocketClient();
export default wsClient;
