import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'http';
import { v4 as uuid } from 'uuid';
import { DocumentState } from './DocumentState.js';
import { TextOperation } from './TextOperation.js';
import { db } from './database.js';
import type {
  WSMessage,
  OperationMessage,
  CursorMessage,
  SelectionMessage,
  ClientInfo,
  CursorPosition,
  SelectionRange,
} from '../types/index.js';

// Client colors for presence indicators
const COLORS = [
  '#3B82F6', // blue
  '#10B981', // green
  '#F59E0B', // amber
  '#EF4444', // red
  '#8B5CF6', // violet
  '#EC4899', // pink
  '#06B6D4', // cyan
  '#F97316', // orange
];

interface ClientConnection {
  ws: WebSocket;
  documentId: string;
  clientId: string;
  userId: string;
  displayName: string;
  color: string;
}

/**
 * SyncServer manages WebSocket connections and coordinates
 * real-time document synchronization.
 */
export class SyncServer {
  private wss: WebSocketServer;
  private documents: Map<string, DocumentState>;
  private clients: Map<WebSocket, ClientConnection>;
  private colorIndex: number;

  constructor(server: Server) {
    this.wss = new WebSocketServer({ server, path: '/ws' });
    this.documents = new Map();
    this.clients = new Map();
    this.colorIndex = 0;

    this.wss.on('connection', (ws, req) => {
      this.handleConnection(ws, req);
    });

    console.log('WebSocket server initialized');
  }

  private async handleConnection(ws: WebSocket, req: { url?: string }): Promise<void> {
    // Parse URL to get documentId and userId
    const url = new URL(req.url || '/', 'http://localhost');
    const documentId = url.searchParams.get('documentId');
    const userId = url.searchParams.get('userId');

    if (!documentId || !userId) {
      ws.close(4000, 'Missing documentId or userId');
      return;
    }

    try {
      // Get user info
      const user = await db.getUser(userId);
      if (!user) {
        ws.close(4001, 'User not found');
        return;
      }

      // Get or create document state
      let docState = this.documents.get(documentId);
      if (!docState) {
        // Check document exists
        const doc = await db.getDocument(documentId);
        if (!doc) {
          ws.close(4002, 'Document not found');
          return;
        }

        docState = new DocumentState(documentId);
        await docState.load();
        this.documents.set(documentId, docState);
      }

      // Create client connection
      const clientId = uuid();
      const color = this.getNextColor();

      const connection: ClientConnection = {
        ws,
        documentId,
        clientId,
        userId,
        displayName: user.displayName,
        color,
      };

      this.clients.set(ws, connection);

      // Register client with document
      const clientInfo: ClientInfo = {
        clientId,
        userId,
        displayName: user.displayName,
        color,
        cursor: null,
        selection: null,
      };
      await docState.addClient(clientInfo);

      // Send initial state
      const initState = docState.getInitState();
      this.send(ws, {
        type: 'init',
        clientId,
        version: initState.version,
        content: initState.content,
        clients: initState.clients,
      });

      // Broadcast join to others
      this.broadcast(
        documentId,
        {
          type: 'client_join',
          clientId,
          userId,
          displayName: user.displayName,
          color,
        },
        ws
      );

      // Set up message handlers
      ws.on('message', (data) => this.handleMessage(ws, data.toString()));
      ws.on('close', () => this.handleDisconnect(ws));
      ws.on('error', (err) => {
        console.error('WebSocket error:', err);
        this.handleDisconnect(ws);
      });

      console.log(`Client ${clientId} connected to document ${documentId}`);
    } catch (error) {
      console.error('Connection error:', error);
      ws.close(4003, 'Connection error');
    }
  }

  private async handleMessage(ws: WebSocket, data: string): Promise<void> {
    const connection = this.clients.get(ws);
    if (!connection) return;

    try {
      const message: WSMessage = JSON.parse(data);
      const docState = this.documents.get(connection.documentId);
      if (!docState) return;

      switch (message.type) {
        case 'operation':
          await this.handleOperation(ws, connection, docState, message as OperationMessage);
          break;
        case 'cursor':
          await this.handleCursor(ws, connection, docState, message as CursorMessage);
          break;
        case 'selection':
          await this.handleSelection(ws, connection, docState, message as SelectionMessage);
          break;
        default:
          console.warn('Unknown message type:', message.type);
      }
    } catch (error) {
      console.error('Message handling error:', error);
      this.send(ws, { type: 'error', message: 'Failed to process message' });
    }
  }

  private async handleOperation(
    ws: WebSocket,
    connection: ClientConnection,
    docState: DocumentState,
    message: OperationMessage
  ): Promise<void> {
    const { version, operation } = message;

    try {
      // Apply operation with OT
      const result = await docState.applyOperation(
        connection.clientId,
        connection.userId,
        version,
        operation
      );

      // Acknowledge to sender
      this.send(ws, {
        type: 'ack',
        version: result.version,
      });

      // Broadcast transformed operation to others
      this.broadcast(
        connection.documentId,
        {
          type: 'operation',
          clientId: connection.clientId,
          version: result.version,
          operation: result.operation,
        },
        ws
      );
    } catch (error) {
      console.error('Operation error:', error);
      // Request client resync
      this.send(ws, {
        type: 'resync',
        version: docState.version,
        content: docState.content,
      });
    }
  }

  private async handleCursor(
    ws: WebSocket,
    connection: ClientConnection,
    docState: DocumentState,
    message: CursorMessage
  ): Promise<void> {
    const position = message.position as CursorPosition;
    await docState.updateCursor(connection.clientId, position);

    // Broadcast to others
    this.broadcast(
      connection.documentId,
      {
        type: 'cursor',
        clientId: connection.clientId,
        position,
      },
      ws
    );
  }

  private async handleSelection(
    ws: WebSocket,
    connection: ClientConnection,
    docState: DocumentState,
    message: SelectionMessage
  ): Promise<void> {
    const selection = message.selection as SelectionRange | null;
    await docState.updateSelection(connection.clientId, selection);

    // Broadcast to others
    this.broadcast(
      connection.documentId,
      {
        type: 'selection',
        clientId: connection.clientId,
        selection,
      },
      ws
    );
  }

  private async handleDisconnect(ws: WebSocket): Promise<void> {
    const connection = this.clients.get(ws);
    if (!connection) return;

    const docState = this.documents.get(connection.documentId);
    if (docState) {
      await docState.removeClient(connection.clientId);

      // Broadcast leave to others
      this.broadcast(
        connection.documentId,
        {
          type: 'client_leave',
          clientId: connection.clientId,
        },
        ws
      );

      // Clean up empty document states
      if (docState.clients.size === 0) {
        // Save snapshot before unloading
        await docState.saveSnapshot();
        this.documents.delete(connection.documentId);
        console.log(`Document ${connection.documentId} unloaded (no active clients)`);
      }
    }

    this.clients.delete(ws);
    console.log(`Client ${connection.clientId} disconnected`);
  }

  private send(ws: WebSocket, message: WSMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  private broadcast(documentId: string, message: WSMessage, excludeWs?: WebSocket): void {
    for (const [ws, connection] of this.clients.entries()) {
      if (connection.documentId === documentId && ws !== excludeWs) {
        this.send(ws, message);
      }
    }
  }

  private getNextColor(): string {
    const color = COLORS[this.colorIndex % COLORS.length];
    this.colorIndex++;
    return color;
  }

  /**
   * Close all connections
   */
  close(): void {
    this.wss.close();
  }
}
