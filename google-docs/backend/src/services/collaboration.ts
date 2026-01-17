import { WebSocket, WebSocketServer } from 'ws';
import { IncomingMessage } from 'http';
import { parse as parseUrl } from 'url';
import pool from '../utils/db.js';
import redis, { redisPub, redisSub } from '../utils/redis.js';
import { transform, transformOperations } from './ot.js';
import type { Operation, PresenceState, WSMessage, UserPublic } from '../types/index.js';

interface ClientConnection {
  ws: WebSocket;
  user: UserPublic;
  documentId: string | null;
  lastActivity: number;
}

interface DocumentState {
  version: number;
  operationLog: Operation[][];
  presence: Map<string, PresenceState>;
}

// In-memory document states
const documents = new Map<string, DocumentState>();

// Client connections
const clients = new Map<WebSocket, ClientConnection>();

// Server ID for distributed coordination
const serverId = Math.random().toString(36).substring(7);

/**
 * Initialize WebSocket server
 */
export function initWebSocket(wss: WebSocketServer): void {
  console.log(`WebSocket server initialized (server: ${serverId})`);

  // Subscribe to Redis channels for cross-server communication
  redisSub.subscribe('doc:operations', 'doc:presence');

  redisSub.on('message', (channel, message) => {
    try {
      const data = JSON.parse(message);

      // Ignore our own messages
      if (data.serverId === serverId) return;

      if (channel === 'doc:operations') {
        broadcastToDocument(data.docId, {
          type: 'OPERATION',
          version: data.version,
          operation: data.operation,
          data: { userId: data.userId, userName: data.userName },
        }, null);
      } else if (channel === 'doc:presence') {
        broadcastToDocument(data.docId, {
          type: 'PRESENCE',
          data: data.presence,
        }, null);
      }
    } catch (error) {
      console.error('Redis message error:', error);
    }
  });

  wss.on('connection', async (ws: WebSocket, request: IncomingMessage) => {
    console.log('New WebSocket connection');

    // Parse token from query string
    const url = parseUrl(request.url || '', true);
    const token = url.query.token as string;

    if (!token) {
      ws.close(4001, 'Authentication required');
      return;
    }

    // Validate token
    const sessionData = await redis.get(`session:${token}`);

    if (!sessionData) {
      ws.close(4001, 'Invalid session');
      return;
    }

    const user = JSON.parse(sessionData) as UserPublic;

    // Register client
    clients.set(ws, {
      ws,
      user,
      documentId: null,
      lastActivity: Date.now(),
    });

    // Handle messages
    ws.on('message', (data) => handleMessage(ws, data.toString()));

    ws.on('close', () => {
      const client = clients.get(ws);
      if (client?.documentId) {
        handleLeaveDocument(ws, client.documentId);
      }
      clients.delete(ws);
    });

    ws.on('error', (error) => {
      console.error('WebSocket error:', error);
    });

    // Send welcome message
    ws.send(JSON.stringify({ type: 'CONNECTED', data: { userId: user.id } }));
  });

  // Cleanup inactive connections every 30 seconds
  setInterval(() => {
    const now = Date.now();
    for (const [ws, client] of clients) {
      if (now - client.lastActivity > 60000) {
        ws.close(4002, 'Inactive');
      }
    }
  }, 30000);
}

/**
 * Handle incoming WebSocket message
 */
async function handleMessage(ws: WebSocket, message: string): Promise<void> {
  const client = clients.get(ws);
  if (!client) return;

  client.lastActivity = Date.now();

  try {
    const msg: WSMessage = JSON.parse(message);

    switch (msg.type) {
      case 'SUBSCRIBE':
        await handleSubscribe(ws, client, msg.doc_id!);
        break;

      case 'UNSUBSCRIBE':
        if (client.documentId) {
          handleLeaveDocument(ws, client.documentId);
        }
        break;

      case 'OPERATION':
        await handleOperation(ws, client, msg);
        break;

      case 'CURSOR':
      case 'PRESENCE':
        handlePresence(ws, client, msg);
        break;

      default:
        ws.send(JSON.stringify({ type: 'ERROR', error: 'Unknown message type' }));
    }
  } catch (error) {
    console.error('Message handling error:', error);
    ws.send(JSON.stringify({ type: 'ERROR', error: 'Invalid message format' }));
  }
}

/**
 * Handle document subscription
 */
async function handleSubscribe(
  ws: WebSocket,
  client: ClientConnection,
  documentId: string
): Promise<void> {
  // Check permission
  const permCheck = await pool.query(
    `SELECT d.owner_id, d.current_version, d.content, dp.permission_level
     FROM documents d
     LEFT JOIN document_permissions dp ON d.id = dp.document_id AND dp.user_id = $2
     WHERE d.id = $1 AND d.is_deleted = false`,
    [documentId, client.user.id]
  );

  if (permCheck.rows.length === 0) {
    ws.send(JSON.stringify({ type: 'ERROR', code: 'NOT_FOUND', error: 'Document not found' }));
    return;
  }

  const { owner_id, current_version, content, permission_level } = permCheck.rows[0];

  if (owner_id !== client.user.id && !permission_level) {
    ws.send(JSON.stringify({ type: 'ERROR', code: 'ACCESS_DENIED', error: 'Access denied' }));
    return;
  }

  // Leave previous document if any
  if (client.documentId) {
    handleLeaveDocument(ws, client.documentId);
  }

  // Join new document
  client.documentId = documentId;

  // Initialize document state if not exists
  if (!documents.has(documentId)) {
    documents.set(documentId, {
      version: current_version,
      operationLog: [],
      presence: new Map(),
    });
  }

  const docState = documents.get(documentId)!;

  // Add user to presence
  const presence: PresenceState = {
    user_id: client.user.id,
    name: client.user.name,
    color: client.user.avatar_color,
    cursor: null,
    selection: null,
    last_active: Date.now(),
  };

  docState.presence.set(client.user.id, presence);

  // Send sync message with current document state
  ws.send(JSON.stringify({
    type: 'SYNC',
    doc_id: documentId,
    version: docState.version,
    data: {
      content,
      presence: Array.from(docState.presence.values()),
      permission_level: owner_id === client.user.id ? 'edit' : permission_level,
    },
  }));

  // Broadcast presence update
  broadcastPresence(documentId, presence);
}

/**
 * Handle leaving a document
 */
function handleLeaveDocument(ws: WebSocket, documentId: string): void {
  const client = clients.get(ws);
  if (!client) return;

  const docState = documents.get(documentId);
  if (docState) {
    docState.presence.delete(client.user.id);

    // Broadcast user left
    broadcastToDocument(documentId, {
      type: 'PRESENCE',
      data: {
        user_id: client.user.id,
        left: true,
      },
    }, ws);
  }

  client.documentId = null;
}

/**
 * Handle operation from client
 */
async function handleOperation(
  ws: WebSocket,
  client: ClientConnection,
  msg: WSMessage
): Promise<void> {
  const documentId = client.documentId;
  if (!documentId || !msg.operation) return;

  const docState = documents.get(documentId);
  if (!docState) return;

  const clientVersion = msg.version || 0;

  // Transform operation against any operations the client hasn't seen
  let transformedOps = msg.operation;

  if (clientVersion < docState.version) {
    const missedOps = docState.operationLog.slice(clientVersion);
    for (const serverOps of missedOps) {
      transformedOps = transformOperations(transformedOps, serverOps);
    }
  }

  // Increment version and store operation
  docState.version++;
  docState.operationLog.push(transformedOps);

  // Limit operation log size (keep last 1000 operations)
  if (docState.operationLog.length > 1000) {
    docState.operationLog = docState.operationLog.slice(-500);
  }

  // Acknowledge to sender
  ws.send(JSON.stringify({
    type: 'ACK',
    version: docState.version,
  }));

  // Broadcast to other clients in document
  broadcastToDocument(documentId, {
    type: 'OPERATION',
    version: docState.version,
    operation: transformedOps,
    data: {
      userId: client.user.id,
      userName: client.user.name,
    },
  }, ws);

  // Publish to Redis for other servers
  redisPub.publish('doc:operations', JSON.stringify({
    serverId,
    docId: documentId,
    version: docState.version,
    operation: transformedOps,
    userId: client.user.id,
    userName: client.user.name,
  }));

  // Persist operation (debounced)
  debouncedPersist(documentId, docState.version, transformedOps, client.user.id);
}

/**
 * Handle presence/cursor update
 */
function handlePresence(ws: WebSocket, client: ClientConnection, msg: WSMessage): void {
  const documentId = client.documentId;
  if (!documentId) return;

  const docState = documents.get(documentId);
  if (!docState) return;

  const presence = docState.presence.get(client.user.id);
  if (!presence) return;

  if (msg.cursor) {
    presence.cursor = msg.cursor;
  }
  if (msg.selection) {
    presence.selection = msg.selection;
  }
  presence.last_active = Date.now();

  // Broadcast to other clients
  broadcastToDocument(documentId, {
    type: 'CURSOR',
    data: presence,
  }, ws);

  // Publish to Redis for other servers
  redisPub.publish('doc:presence', JSON.stringify({
    serverId,
    docId: documentId,
    presence,
  }));
}

/**
 * Broadcast presence update
 */
function broadcastPresence(documentId: string, presence: PresenceState): void {
  broadcastToDocument(documentId, {
    type: 'PRESENCE',
    data: presence,
  }, null);

  redisPub.publish('doc:presence', JSON.stringify({
    serverId,
    docId: documentId,
    presence,
  }));
}

/**
 * Broadcast message to all clients in a document
 */
function broadcastToDocument(
  documentId: string,
  message: WSMessage,
  exclude: WebSocket | null
): void {
  const messageStr = JSON.stringify(message);

  for (const [ws, client] of clients) {
    if (client.documentId === documentId && ws !== exclude && ws.readyState === WebSocket.OPEN) {
      ws.send(messageStr);
    }
  }
}

// Debounce persistence
const persistTimers = new Map<string, NodeJS.Timeout>();

function debouncedPersist(
  documentId: string,
  version: number,
  operation: Operation[],
  userId: string
): void {
  const existingTimer = persistTimers.get(documentId);
  if (existingTimer) {
    clearTimeout(existingTimer);
  }

  persistTimers.set(documentId, setTimeout(async () => {
    try {
      // Store operation
      await pool.query(
        `INSERT INTO operations (document_id, version_number, operation, user_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (document_id, version_number) DO NOTHING`,
        [documentId, version, JSON.stringify(operation), userId]
      );

      // Update document version
      await pool.query(
        `UPDATE documents SET current_version = $1, updated_at = NOW() WHERE id = $2`,
        [version, documentId]
      );

      // Create snapshot every 100 versions
      if (version % 100 === 0) {
        const docResult = await pool.query(
          'SELECT content FROM documents WHERE id = $1',
          [documentId]
        );

        if (docResult.rows.length > 0) {
          await pool.query(
            `INSERT INTO document_versions (document_id, version_number, content, created_by)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (document_id, version_number) DO NOTHING`,
            [documentId, version, docResult.rows[0].content, userId]
          );
        }
      }
    } catch (error) {
      console.error('Persist error:', error);
    }

    persistTimers.delete(documentId);
  }, 1000));
}

/**
 * Get active users in a document
 */
export function getDocumentPresence(documentId: string): PresenceState[] {
  const docState = documents.get(documentId);
  if (!docState) return [];
  return Array.from(docState.presence.values());
}
