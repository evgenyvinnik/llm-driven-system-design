/**
 * WebSocket service for real-time document collaboration.
 * Manages connection lifecycle, message handling, and operation buffering.
 * Implements automatic reconnection with exponential backoff.
 */

import type { WSMessage, PresenceState, Operation, DocumentContent } from '../types';

/** Function type for WebSocket message handlers */
type MessageHandler = (message: WSMessage) => void;

/**
 * WebSocket service class for managing real-time collaboration connections.
 * Singleton instance exported as wsService.
 */
class WebSocketService {
  /** Active WebSocket connection */
  private ws: WebSocket | null = null;
  /** Authentication token for WebSocket connection */
  private token: string | null = null;
  /** Currently subscribed document ID */
  private documentId: string | null = null;
  /** Set of registered message handlers */
  private messageHandlers: Set<MessageHandler> = new Set();
  /** Current reconnection attempt count */
  private reconnectAttempts = 0;
  /** Maximum number of reconnection attempts */
  private maxReconnectAttempts = 5;
  /** Base delay between reconnection attempts (ms) */
  private reconnectDelay = 1000;
  /** Queue of operations awaiting server acknowledgment */
  private pendingOperations: Array<{ operation: Operation[]; version: number }> = [];
  /** Flag to prevent duplicate connection attempts */
  private isConnecting = false;

  /**
   * Sets the authentication token for WebSocket connections.
   * @param token - Session token or null to clear
   */
  setToken(token: string | null) {
    this.token = token;
  }

  /**
   * Establishes a WebSocket connection to the server.
   * Automatically resubscribes to the current document on reconnect.
   * @returns Promise that resolves when connected
   */
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

  /**
   * Closes the WebSocket connection and clears state.
   * Should be called when logging out or leaving the application.
   */
  disconnect() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.documentId = null;
    this.pendingOperations = [];
  }

  /**
   * Subscribes to a document for real-time updates.
   * Receives document content, presence info, and ongoing edits.
   * @param documentId - Document UUID to subscribe to
   */
  subscribe(documentId: string) {
    this.documentId = documentId;
    this.send({ type: 'SUBSCRIBE', doc_id: documentId });
  }

  /**
   * Unsubscribes from the current document.
   * Called when navigating away from the document editor.
   */
  unsubscribe() {
    if (this.documentId) {
      this.send({ type: 'UNSUBSCRIBE', doc_id: this.documentId });
      this.documentId = null;
    }
  }

  /**
   * Sends an edit operation to the server.
   * Operations are queued and acknowledged for conflict resolution.
   * @param operation - Array of operations to apply
   * @param version - Client's current document version
   */
  sendOperation(operation: Operation[], version: number) {
    this.pendingOperations.push({ operation, version });
    this.send({
      type: 'OPERATION',
      doc_id: this.documentId!,
      version,
      operation,
    });
  }

  /**
   * Sends cursor position update to other collaborators.
   * @param position - Cursor position in the document
   */
  sendCursor(position: number) {
    this.send({
      type: 'CURSOR',
      doc_id: this.documentId!,
      cursor: { position },
    });
  }

  /**
   * Sends text selection update to other collaborators.
   * @param start - Selection start position
   * @param end - Selection end position
   */
  sendSelection(start: number, end: number) {
    this.send({
      type: 'CURSOR',
      doc_id: this.documentId!,
      selection: { start, end },
    });
  }

  /**
   * Sends a message over the WebSocket connection.
   * Silently fails if connection is not open.
   * @param message - WebSocket message to send
   */
  private send(message: WSMessage) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  /**
   * Handles incoming WebSocket messages.
   * Processes ACKs to clear pending operations and notifies handlers.
   * @param message - Received WebSocket message
   */
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

  /**
   * Registers a message handler for incoming WebSocket messages.
   * @param handler - Function to call with each received message
   * @returns Function to unregister the handler
   */
  addMessageHandler(handler: MessageHandler) {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  /**
   * Checks if the WebSocket connection is currently open.
   * @returns True if connected
   */
  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /**
   * Returns the ID of the currently subscribed document.
   * @returns Document UUID or null if not subscribed
   */
  getCurrentDocumentId(): string | null {
    return this.documentId;
  }
}

/** Singleton WebSocket service instance */
export const wsService = new WebSocketService();

/** Default export for convenience */
export default wsService;
