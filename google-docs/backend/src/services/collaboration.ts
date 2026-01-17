import { WebSocket, WebSocketServer } from 'ws';
import { IncomingMessage } from 'http';
import { parse as parseUrl } from 'url';
import pool from '../utils/db.js';
import redis, { redisPub, redisSub } from '../utils/redis.js';
import { transform, transformOperations } from './ot.js';
import type { Operation, PresenceState, WSMessage, UserPublic } from '../types/index.js';
import logger, { createChildLogger } from '../shared/logger.js';
import {
  activeDocumentsGauge,
  activeCollaboratorsGauge,
  syncLatencyHistogram,
  operationsCounter,
  conflictsCounter,
  recordCacheAccess,
} from '../shared/metrics.js';
import { createCircuitBreaker, OT_SYNC_OPTIONS, isCircuitOpen } from '../shared/circuitBreaker.js';
import {
  getIdempotencyResult,
  setIdempotencyResult,
  generateOperationKey,
} from '../shared/idempotency.js';

/**
 * Represents a connected WebSocket client with their session info.
 * Tracks which document they are currently viewing and activity timestamp.
 */
interface ClientConnection {
  ws: WebSocket;
  user: UserPublic;
  documentId: string | null;
  lastActivity: number;
}

/**
 * In-memory state for an active document being edited.
 * Contains the current version, operation log for OT, and connected users' presence.
 */
interface DocumentState {
  version: number;
  operationLog: Operation[][];
  presence: Map<string, PresenceState>;
}

/** In-memory cache of active document states for real-time collaboration */
const documents = new Map<string, DocumentState>();

/** Map of WebSocket connections to their client metadata */
const clients = new Map<WebSocket, ClientConnection>();

/**
 * Unique identifier for this server instance.
 * Used to filter out self-originated Redis pub/sub messages in multi-server deployments.
 */
const serverId = Math.random().toString(36).substring(7);

/**
 * Circuit breaker wrapped database persist function.
 * Protects against slow/failing database during high load.
 */
async function persistOperationToDb(
  documentId: string,
  version: number,
  operation: Operation[],
  userId: string
): Promise<void> {
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
}

const persistCircuitBreaker = createCircuitBreaker(
  'db-persist',
  persistOperationToDb,
  OT_SYNC_OPTIONS
);

/**
 * Circuit breaker wrapped Redis publish function.
 */
async function publishToRedis(channel: string, message: string): Promise<void> {
  await redisPub.publish(channel, message);
}

const redisPublishCircuitBreaker = createCircuitBreaker(
  'redis-publish',
  publishToRedis,
  OT_SYNC_OPTIONS
);

/**
 * Returns current collaboration statistics for health checks.
 */
export function getCollaborationStats(): { activeDocuments: number; activeConnections: number } {
  return {
    activeDocuments: documents.size,
    activeConnections: clients.size,
  };
}

/**
 * Initializes the WebSocket server for real-time collaboration.
 * Sets up Redis pub/sub for cross-server communication.
 * Handles client connections, authentication, and message routing.
 *
 * @param wss - The WebSocket server instance to configure
 */
export function initWebSocket(wss: WebSocketServer): void {
  logger.info({ serverId }, 'WebSocket server initialized');

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
      logger.error({ error, channel }, 'Redis message parsing error');
    }
  });

  wss.on('connection', async (ws: WebSocket, request: IncomingMessage) => {
    const connectionId = Math.random().toString(36).substring(7);
    const connLogger = createChildLogger({ connectionId });

    connLogger.debug('New WebSocket connection attempt');

    // Parse token from query string
    const url = parseUrl(request.url || '', true);
    const token = url.query.token as string;

    if (!token) {
      connLogger.warn('Connection rejected: no token');
      ws.close(4001, 'Authentication required');
      return;
    }

    // Validate token
    const sessionData = await redis.get(`session:${token}`);

    if (!sessionData) {
      recordCacheAccess('session', false);
      connLogger.warn('Connection rejected: invalid session');
      ws.close(4001, 'Invalid session');
      return;
    }

    recordCacheAccess('session', true);
    const user = JSON.parse(sessionData) as UserPublic;

    connLogger.info({ userId: user.id, userName: user.name }, 'WebSocket authenticated');

    // Register client
    clients.set(ws, {
      ws,
      user,
      documentId: null,
      lastActivity: Date.now(),
    });

    // Update metrics
    activeCollaboratorsGauge.set(clients.size);

    // Handle messages
    ws.on('message', (data) => handleMessage(ws, data.toString()));

    ws.on('close', () => {
      const client = clients.get(ws);
      if (client?.documentId) {
        handleLeaveDocument(ws, client.documentId);
      }
      clients.delete(ws);
      activeCollaboratorsGauge.set(clients.size);

      connLogger.info({ userId: user.id }, 'WebSocket disconnected');
    });

    ws.on('error', (error) => {
      connLogger.error({ error: error.message }, 'WebSocket error');
    });

    // Send welcome message
    ws.send(JSON.stringify({ type: 'CONNECTED', data: { userId: user.id } }));
  });

  // Cleanup inactive connections every 30 seconds
  setInterval(() => {
    const now = Date.now();
    for (const [ws, client] of clients) {
      if (now - client.lastActivity > 60000) {
        logger.debug({ userId: client.user.id }, 'Closing inactive connection');
        ws.close(4002, 'Inactive');
      }
    }
  }, 30000);
}

/**
 * Routes incoming WebSocket messages to appropriate handlers.
 * Updates client activity timestamp to prevent timeout disconnection.
 * Handles subscribe, unsubscribe, operation, and presence messages.
 *
 * @param ws - The WebSocket connection that sent the message
 * @param message - The raw JSON message string
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
    logger.error({ error, userId: client.user.id }, 'Message handling error');
    ws.send(JSON.stringify({ type: 'ERROR', error: 'Invalid message format' }));
  }
}

/**
 * Handles a client subscribing to a document for real-time updates.
 * Verifies document access permission before allowing subscription.
 * Initializes document state if not already cached.
 * Sends sync message with current document content and online users.
 *
 * @param ws - The WebSocket connection subscribing
 * @param client - The client's connection metadata
 * @param documentId - The document UUID to subscribe to
 */
async function handleSubscribe(
  ws: WebSocket,
  client: ClientConnection,
  documentId: string
): Promise<void> {
  const opLogger = createChildLogger({
    userId: client.user.id,
    documentId,
    action: 'subscribe',
  });

  // Check permission
  const permCheck = await pool.query(
    `SELECT d.owner_id, d.current_version, d.content, dp.permission_level
     FROM documents d
     LEFT JOIN document_permissions dp ON d.id = dp.document_id AND dp.user_id = $2
     WHERE d.id = $1 AND d.is_deleted = false`,
    [documentId, client.user.id]
  );

  if (permCheck.rows.length === 0) {
    opLogger.warn('Subscribe failed: document not found');
    ws.send(JSON.stringify({ type: 'ERROR', code: 'NOT_FOUND', error: 'Document not found' }));
    return;
  }

  const { owner_id, current_version, content, permission_level } = permCheck.rows[0];

  if (owner_id !== client.user.id && !permission_level) {
    opLogger.warn('Subscribe failed: access denied');
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
    activeDocumentsGauge.set(documents.size);
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

  opLogger.info({
    version: docState.version,
    activeUsers: docState.presence.size,
  }, 'User subscribed to document');

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
 * Handles a client leaving/unsubscribing from a document.
 * Removes their presence from the document state.
 * Broadcasts departure to other users in the document.
 *
 * @param ws - The WebSocket connection leaving
 * @param documentId - The document UUID being left
 */
function handleLeaveDocument(ws: WebSocket, documentId: string): void {
  const client = clients.get(ws);
  if (!client) return;

  const docState = documents.get(documentId);
  if (docState) {
    docState.presence.delete(client.user.id);

    logger.debug({
      userId: client.user.id,
      documentId,
      remainingUsers: docState.presence.size,
    }, 'User left document');

    // Broadcast user left
    broadcastToDocument(documentId, {
      type: 'PRESENCE',
      data: {
        user_id: client.user.id,
        left: true,
      },
    }, ws);

    // Clean up empty document states
    if (docState.presence.size === 0) {
      documents.delete(documentId);
      activeDocumentsGauge.set(documents.size);
    }
  }

  client.documentId = null;
}

/**
 * Handles an edit operation from a client.
 * Transforms the operation against any concurrent operations (OT).
 * Uses idempotency keys to prevent duplicate operations on retry.
 * Broadcasts to other clients and persists to database.
 *
 * @param ws - The WebSocket connection sending the operation
 * @param client - The client's connection metadata
 * @param msg - The WebSocket message containing the operation
 */
async function handleOperation(
  ws: WebSocket,
  client: ClientConnection,
  msg: WSMessage
): Promise<void> {
  const startTime = Date.now();
  const documentId = client.documentId;
  if (!documentId || !msg.operation) return;

  const docState = documents.get(documentId);
  if (!docState) return;

  const opLogger = createChildLogger({
    userId: client.user.id,
    documentId,
    action: 'operation',
  });

  // Check idempotency if operation ID provided
  const operationId = (msg.data as { operationId?: string })?.operationId;
  if (operationId) {
    const idempotencyKey = generateOperationKey(client.user.id, documentId, operationId);
    const cachedResult = await getIdempotencyResult(idempotencyKey);

    if (cachedResult) {
      opLogger.debug({ operationId }, 'Duplicate operation detected (idempotency hit)');
      // Return the cached ACK
      ws.send(JSON.stringify(cachedResult.result));
      return;
    }
  }

  const clientVersion = msg.version || 0;

  // Transform operation against any operations the client hasn't seen
  let transformedOps = msg.operation;
  let hadConflicts = false;

  if (clientVersion < docState.version) {
    const missedOps = docState.operationLog.slice(clientVersion);
    for (const serverOps of missedOps) {
      transformedOps = transformOperations(transformedOps, serverOps);
    }
    hadConflicts = true;
    conflictsCounter.inc();
    opLogger.debug({
      clientVersion,
      serverVersion: docState.version,
      missedOps: missedOps.length,
    }, 'OT conflict resolved');
  }

  // Increment version and store operation
  docState.version++;
  docState.operationLog.push(transformedOps);

  // Track operation types for metrics
  for (const op of transformedOps) {
    operationsCounter.inc({ operation_type: op.type });
  }

  // Limit operation log size (keep last 1000 operations)
  if (docState.operationLog.length > 1000) {
    docState.operationLog = docState.operationLog.slice(-500);
  }

  // Prepare ACK message
  const ackMessage = {
    type: 'ACK',
    version: docState.version,
  };

  // Acknowledge to sender
  ws.send(JSON.stringify(ackMessage));

  // Store idempotency result if key provided
  if (operationId) {
    const idempotencyKey = generateOperationKey(client.user.id, documentId, operationId);
    await setIdempotencyResult(idempotencyKey, ackMessage);
  }

  // Record sync latency
  const latencyMs = Date.now() - startTime;
  syncLatencyHistogram.observe({ operation_type: transformedOps[0]?.type || 'unknown' }, latencyMs);

  opLogger.debug({
    version: docState.version,
    latencyMs,
    hadConflicts,
    operationCount: transformedOps.length,
  }, 'Operation processed');

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

  // Publish to Redis for other servers (with circuit breaker)
  try {
    await redisPublishCircuitBreaker.fire('doc:operations', JSON.stringify({
      serverId,
      docId: documentId,
      version: docState.version,
      operation: transformedOps,
      userId: client.user.id,
      userName: client.user.name,
    }));
  } catch (error) {
    if (isCircuitOpen(error)) {
      opLogger.warn('Redis publish circuit open, operation not broadcast to other servers');
    } else {
      opLogger.error({ error }, 'Failed to publish operation to Redis');
    }
  }

  // Persist operation (debounced with circuit breaker)
  debouncedPersist(documentId, docState.version, transformedOps, client.user.id);
}

/**
 * Handles cursor/selection updates from a client.
 * Updates the client's presence state and broadcasts to others.
 * Published via Redis for cross-server visibility.
 *
 * @param ws - The WebSocket connection sending the update
 * @param client - The client's connection metadata
 * @param msg - The WebSocket message with cursor/selection data
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

  // Publish to Redis for other servers (fire and forget, no circuit breaker for presence)
  redisPub.publish('doc:presence', JSON.stringify({
    serverId,
    docId: documentId,
    presence,
  })).catch((error) => {
    logger.trace({ error, documentId }, 'Failed to publish presence to Redis');
  });
}

/**
 * Broadcasts a presence update to all clients in a document.
 * Also publishes to Redis for cross-server notification.
 *
 * @param documentId - The document UUID
 * @param presence - The presence state to broadcast
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
  })).catch((error) => {
    logger.trace({ error, documentId }, 'Failed to publish presence to Redis');
  });
}

/**
 * Sends a message to all clients connected to a specific document.
 * Optionally excludes a specific connection (typically the sender).
 *
 * @param documentId - The document UUID to broadcast to
 * @param message - The WebSocket message to send
 * @param exclude - Optional WebSocket connection to exclude from broadcast
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

/** Timers for debounced database persistence per document */
const persistTimers = new Map<string, NodeJS.Timeout>();

/**
 * Debounces database persistence of operations.
 * Batches rapid edits to reduce database writes.
 * Uses circuit breaker to protect against slow/failing database.
 *
 * @param documentId - The document UUID
 * @param version - The new version number
 * @param operation - The operation(s) to persist
 * @param userId - The user who made the edit
 */
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
      await persistCircuitBreaker.fire(documentId, version, operation, userId);
      logger.debug({ documentId, version }, 'Operation persisted to database');
    } catch (error) {
      if (isCircuitOpen(error)) {
        logger.warn({ documentId, version }, 'Database persist circuit open, operation queued');
        // Retry after circuit reset
        setTimeout(() => {
          debouncedPersist(documentId, version, operation, userId);
        }, 15000);
      } else {
        logger.error({ error, documentId, version }, 'Failed to persist operation');
      }
    }

    persistTimers.delete(documentId);
  }, 1000));
}

/**
 * Returns the current list of online users for a document.
 * Used for displaying presence indicators in the UI.
 *
 * @param documentId - The document UUID
 * @returns Array of presence states for all connected users
 */
export function getDocumentPresence(documentId: string): PresenceState[] {
  const docState = documents.get(documentId);
  if (!docState) return [];
  return Array.from(docState.presence.values());
}
