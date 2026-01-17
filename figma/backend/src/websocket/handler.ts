import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'http';
import { v4 as uuidv4 } from 'uuid';
import type { WSMessage, PresenceState, Operation, CanvasData } from '../types/index.js';
import { fileService } from '../services/fileService.js';
import { presenceService } from '../services/presenceService.js';
import { operationService } from '../services/operationService.js';
import {
  logger,
  createCircuitBreaker,
  registerCircuitBreaker,
  syncConfig,
  withIdempotency,
  generateFileOperationKey,
  activeCollaboratorsGauge,
  syncLatencyHistogram,
  operationsCounter,
  operationLatencyHistogram,
} from '../shared/index.js';

/**
 * Extended WebSocket with additional properties for tracking user state.
 * Adds user identification and file subscription information.
 */
interface ExtendedWebSocket extends WebSocket {
  id: string;
  userId?: string;
  userName?: string;
  fileId?: string;
  userColor?: string;
  isAlive: boolean;
}

/**
 * Map of file IDs to connected WebSocket clients.
 * Enables broadcasting to all users viewing a specific file.
 */
// Map of fileId -> Set of connected clients
const fileClients = new Map<string, Set<ExtendedWebSocket>>();

/**
 * Pending operations awaiting batch broadcast.
 * Operations are batched for network efficiency.
 */
// Pending operations batch
const pendingOperations = new Map<string, Operation[]>();

/**
 * Batch interval for operation broadcasts in milliseconds.
 * Trades off latency for reduced network overhead.
 */
const BATCH_INTERVAL = 50; // 50ms batching window

/**
 * Circuit breaker for sync/broadcast operations.
 * Protects against cascading failures in real-time collaboration.
 */
const syncCircuitBreaker = createCircuitBreaker(
  'sync',
  async (fileId: string, message: WSMessage, exclude?: ExtendedWebSocket) => {
    const clients = fileClients.get(fileId);
    if (!clients) return;

    const data = JSON.stringify(message);
    let successCount = 0;
    let errorCount = 0;

    clients.forEach((client) => {
      if (client !== exclude && client.readyState === WebSocket.OPEN) {
        try {
          client.send(data);
          successCount++;
        } catch {
          errorCount++;
        }
      }
    });

    if (errorCount > 0 && successCount === 0) {
      throw new Error(`Failed to broadcast to any clients in file ${fileId}`);
    }

    return { successCount, errorCount };
  },
  syncConfig
);

registerCircuitBreaker('sync', syncCircuitBreaker);

/**
 * Sets up the WebSocket server for real-time collaboration.
 * Handles client connections, message routing, and heartbeat monitoring.
 * @param server - The HTTP server to attach the WebSocket server to
 * @returns The configured WebSocketServer instance
 */
export function setupWebSocket(server: Server): WebSocketServer {
  const wss = new WebSocketServer({ server, path: '/ws' });

  // Heartbeat interval
  const heartbeatInterval = setInterval(() => {
    wss.clients.forEach((ws) => {
      const extWs = ws as ExtendedWebSocket;
      if (!extWs.isAlive) {
        return extWs.terminate();
      }
      extWs.isAlive = false;
      extWs.ping();
    });
  }, 30000);

  // Operation batching interval
  setInterval(() => {
    const batchStart = Date.now();
    pendingOperations.forEach((ops, fileId) => {
      if (ops.length > 0) {
        broadcastToFile(fileId, {
          type: 'operation',
          payload: { operations: ops },
          fileId,
        });
        pendingOperations.set(fileId, []);

        // Track sync latency
        syncLatencyHistogram.observe(
          { message_type: 'operation_batch' },
          (Date.now() - batchStart) / 1000
        );
      }
    });
  }, BATCH_INTERVAL);

  wss.on('close', () => {
    clearInterval(heartbeatInterval);
  });

  wss.on('connection', (ws: WebSocket) => {
    const extWs = ws as ExtendedWebSocket;
    extWs.id = uuidv4();
    extWs.isAlive = true;

    logger.info({ clientId: extWs.id }, 'WebSocket client connected');

    extWs.on('pong', () => {
      extWs.isAlive = true;
    });

    extWs.on('message', async (data) => {
      try {
        const message: WSMessage = JSON.parse(data.toString());
        await handleMessage(extWs, message);
      } catch (error) {
        logger.error({ clientId: extWs.id, error }, 'WebSocket message error');
        sendError(extWs, 'Invalid message format');
      }
    });

    extWs.on('close', () => {
      handleDisconnect(extWs);
    });

    extWs.on('error', (error) => {
      logger.error({ clientId: extWs.id, error }, 'WebSocket error');
      handleDisconnect(extWs);
    });
  });

  logger.info('WebSocket server initialized');
  return wss;
}

/**
 * Routes incoming WebSocket messages to appropriate handlers.
 * @param ws - The WebSocket connection
 * @param message - The parsed message to handle
 */
async function handleMessage(ws: ExtendedWebSocket, message: WSMessage): Promise<void> {
  switch (message.type) {
    case 'subscribe':
      await handleSubscribe(ws, message);
      break;
    case 'unsubscribe':
      await handleUnsubscribe(ws);
      break;
    case 'operation':
      await handleOperation(ws, message);
      break;
    case 'presence':
      await handlePresence(ws, message);
      break;
    case 'sync':
      await handleSync(ws, message);
      break;
    default:
      sendError(ws, `Unknown message type: ${message.type}`);
  }
}

/**
 * Handles a client subscribing to a file for real-time updates.
 * Sends current file state and presence, notifies other users.
 * @param ws - The WebSocket connection
 * @param message - The subscribe message with file and user info
 */
async function handleSubscribe(ws: ExtendedWebSocket, message: WSMessage): Promise<void> {
  const payload = message.payload as {
    fileId: string;
    userId: string;
    userName: string;
  };

  const { fileId, userId, userName } = payload;

  // Leave previous file if any
  if (ws.fileId) {
    await handleUnsubscribe(ws);
  }

  ws.fileId = fileId;
  ws.userId = userId;
  ws.userName = userName;
  ws.userColor = presenceService.getColorForUser(userId);

  // Add to file clients
  if (!fileClients.has(fileId)) {
    fileClients.set(fileId, new Set());
  }
  fileClients.get(fileId)!.add(ws);

  // Update metrics
  const clientCount = fileClients.get(fileId)!.size;
  activeCollaboratorsGauge.set({ file_id: fileId }, clientCount);

  // Get file data
  const file = await fileService.getFile(fileId);
  if (!file) {
    sendError(ws, 'File not found');
    return;
  }

  // Get existing presence
  const presence = await presenceService.getFilePresence(fileId);

  // Send sync message with file data and presence
  send(ws, {
    type: 'sync',
    payload: {
      file: {
        id: file.id,
        name: file.name,
        canvas_data: file.canvas_data,
      },
      presence,
      yourColor: ws.userColor,
    },
    fileId,
  });

  // Notify others of new user
  const newPresence: PresenceState = {
    userId,
    userName,
    userColor: ws.userColor,
    selection: [],
    lastActive: Date.now(),
  };

  await presenceService.updatePresence(fileId, newPresence);

  broadcastToFile(fileId, {
    type: 'presence',
    payload: { presence: [newPresence] },
    fileId,
  }, ws);

  logger.info({ userName, userId, fileId, clientCount }, 'User subscribed to file');
}

/**
 * Handles a client unsubscribing from a file.
 * Cleans up presence and notifies remaining users.
 * @param ws - The WebSocket connection
 */
async function handleUnsubscribe(ws: ExtendedWebSocket): Promise<void> {
  if (!ws.fileId) return;

  const fileId = ws.fileId;
  const clients = fileClients.get(fileId);

  if (clients) {
    clients.delete(ws);
    const remaining = clients.size;

    if (remaining === 0) {
      fileClients.delete(fileId);
      activeCollaboratorsGauge.set({ file_id: fileId }, 0);
    } else {
      activeCollaboratorsGauge.set({ file_id: fileId }, remaining);
    }
  }

  // Remove presence
  if (ws.userId) {
    await presenceService.removePresence(fileId, ws.userId);

    // Notify others
    broadcastToFile(fileId, {
      type: 'presence',
      payload: {
        removed: [ws.userId],
      },
      fileId,
    });
  }

  logger.info({ userName: ws.userName, fileId }, 'User unsubscribed from file');

  ws.fileId = undefined;
}

/**
 * Handles incoming design operations from a client.
 * Processes with idempotency, stores, acknowledges, and broadcasts operations.
 * @param ws - The WebSocket connection
 * @param message - The operation message with operations array
 */
async function handleOperation(ws: ExtendedWebSocket, message: WSMessage): Promise<void> {
  if (!ws.fileId || !ws.userId) {
    sendError(ws, 'Not subscribed to any file');
    return;
  }

  const payload = message.payload as { operations: (Operation & { idempotencyKey?: string })[] };
  const { operations } = payload;

  const processedOps: Operation[] = [];

  for (const op of operations) {
    const opStart = Date.now();
    try {
      // Generate idempotency key if not provided by client
      const idempotencyKey = op.idempotencyKey || uuidv4();

      // Process operation with idempotency protection
      const operation = await withIdempotency(
        generateFileOperationKey(ws.fileId, op.operationType, idempotencyKey),
        async () => {
          const processedOp: Operation = {
            ...op,
            id: op.id || uuidv4(),
            fileId: ws.fileId!,
            userId: ws.userId!,
            timestamp: operationService.getNextTimestamp(),
            clientId: ws.id,
          };

          await operationService.processOperation(processedOp);
          return processedOp;
        }
      );

      processedOps.push(operation);

      // Add to batch for broadcasting
      if (!pendingOperations.has(ws.fileId)) {
        pendingOperations.set(ws.fileId, []);
      }
      pendingOperations.get(ws.fileId)!.push(operation);

      // Track metrics
      operationsCounter.inc({ operation_type: op.operationType, status: 'success' });
      operationLatencyHistogram.observe(
        { operation_type: op.operationType },
        (Date.now() - opStart) / 1000
      );
    } catch (error) {
      logger.error({ clientId: ws.id, operation: op, error }, 'Operation error');
      operationsCounter.inc({ operation_type: op.operationType, status: 'error' });
      sendError(ws, `Operation failed: ${(error as Error).message}`);
    }
  }

  // Send ack to sender
  send(ws, {
    type: 'ack',
    payload: {
      operationIds: processedOps.map(o => o.id),
    },
    fileId: ws.fileId,
  });
}

/**
 * Handles presence updates from a client (cursor, selection, viewport).
 * Broadcasts immediately to other users for low-latency collaboration.
 * @param ws - The WebSocket connection
 * @param message - The presence message with cursor/selection data
 */
async function handlePresence(ws: ExtendedWebSocket, message: WSMessage): Promise<void> {
  if (!ws.fileId || !ws.userId) {
    return;
  }

  const payload = message.payload as Partial<PresenceState>;

  const presence: PresenceState = {
    userId: ws.userId,
    userName: ws.userName || 'Anonymous',
    userColor: ws.userColor || '#888888',
    cursor: payload.cursor,
    selection: payload.selection || [],
    viewport: payload.viewport,
    lastActive: Date.now(),
  };

  await presenceService.updatePresence(ws.fileId, presence);

  // Broadcast to others (skip batching for presence - send immediately)
  const start = Date.now();
  broadcastToFile(ws.fileId, {
    type: 'presence',
    payload: { presence: [presence] },
    fileId: ws.fileId,
  }, ws);

  syncLatencyHistogram.observe({ message_type: 'presence' }, (Date.now() - start) / 1000);
}

/**
 * Handles a sync request from a client.
 * Returns current file state and any operations since the given timestamp.
 * @param ws - The WebSocket connection
 * @param message - The sync message with optional sinceTimestamp
 */
async function handleSync(ws: ExtendedWebSocket, message: WSMessage): Promise<void> {
  if (!ws.fileId) {
    sendError(ws, 'Not subscribed to any file');
    return;
  }

  const payload = message.payload as { sinceTimestamp?: number };
  const sinceTimestamp = payload.sinceTimestamp || 0;

  // Get operations since timestamp
  const operations = await operationService.getOperationsSince(ws.fileId, sinceTimestamp);

  // Get current file state
  const file = await fileService.getFile(ws.fileId);
  if (!file) {
    sendError(ws, 'File not found');
    return;
  }

  send(ws, {
    type: 'sync',
    payload: {
      file: {
        id: file.id,
        name: file.name,
        canvas_data: file.canvas_data,
      },
      operations,
    },
    fileId: ws.fileId,
  });
}

/**
 * Handles WebSocket disconnection.
 * Cleans up resources and notifies other users.
 * @param ws - The disconnected WebSocket
 */
function handleDisconnect(ws: ExtendedWebSocket): void {
  logger.info({ clientId: ws.id, userName: ws.userName }, 'WebSocket client disconnected');
  handleUnsubscribe(ws);
}

/**
 * Sends a message to a single WebSocket client.
 * Checks connection state before sending.
 * @param ws - The target WebSocket
 * @param message - The message to send
 */
function send(ws: ExtendedWebSocket, message: WSMessage): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

/**
 * Sends an error message to a WebSocket client.
 * @param ws - The target WebSocket
 * @param error - The error message string
 */
function sendError(ws: ExtendedWebSocket, error: string): void {
  send(ws, {
    type: 'error',
    payload: { error },
  });
}

/**
 * Broadcasts a message to all clients viewing a specific file.
 * Uses circuit breaker for resilience.
 * @param fileId - The file to broadcast to
 * @param message - The message to broadcast
 * @param exclude - Optional client to exclude from broadcast
 */
function broadcastToFile(fileId: string, message: WSMessage, exclude?: ExtendedWebSocket): void {
  // Use circuit breaker for broadcast operations
  syncCircuitBreaker.fire(fileId, message, exclude).catch((error: unknown) => {
    logger.warn({ fileId, error }, 'Broadcast failed (circuit breaker may be open)');
  });
}

/**
 * Gets the count of connected users for a specific file.
 * Used for displaying active user count in the UI.
 * @param fileId - The file to get user count for
 * @returns The number of connected users
 */
// Get connected users count for a file
export function getFileUserCount(fileId: string): number {
  return fileClients.get(fileId)?.size || 0;
}

/**
 * Gets the total number of WebSocket connections.
 * Used for health checks and capacity monitoring.
 * @returns Total connection count
 */
export function getTotalConnections(): number {
  let total = 0;
  fileClients.forEach((clients) => {
    total += clients.size;
  });
  return total;
}

/**
 * Gets information about all active file subscriptions.
 * Used for debugging and monitoring.
 * @returns Map of file IDs to user counts
 */
export function getFileSubscriptions(): Map<string, number> {
  const subscriptions = new Map<string, number>();
  fileClients.forEach((clients, fileId) => {
    subscriptions.set(fileId, clients.size);
  });
  return subscriptions;
}
