import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'http';
import { v4 as uuidv4 } from 'uuid';
import type { WSMessage, PresenceState, Operation, CanvasData } from '../types/index.js';
import { fileService } from '../services/fileService.js';
import { presenceService } from '../services/presenceService.js';
import { operationService } from '../services/operationService.js';

interface ExtendedWebSocket extends WebSocket {
  id: string;
  userId?: string;
  userName?: string;
  fileId?: string;
  userColor?: string;
  isAlive: boolean;
}

// Map of fileId -> Set of connected clients
const fileClients = new Map<string, Set<ExtendedWebSocket>>();

// Pending operations batch
const pendingOperations = new Map<string, Operation[]>();
const BATCH_INTERVAL = 50; // 50ms batching window

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
    pendingOperations.forEach((ops, fileId) => {
      if (ops.length > 0) {
        broadcastToFile(fileId, {
          type: 'operation',
          payload: { operations: ops },
          fileId,
        });
        pendingOperations.set(fileId, []);
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

    console.log(`WebSocket client connected: ${extWs.id}`);

    extWs.on('pong', () => {
      extWs.isAlive = true;
    });

    extWs.on('message', async (data) => {
      try {
        const message: WSMessage = JSON.parse(data.toString());
        await handleMessage(extWs, message);
      } catch (error) {
        console.error('WebSocket message error:', error);
        sendError(extWs, 'Invalid message format');
      }
    });

    extWs.on('close', () => {
      handleDisconnect(extWs);
    });

    extWs.on('error', (error) => {
      console.error('WebSocket error:', error);
      handleDisconnect(extWs);
    });
  });

  console.log('WebSocket server initialized');
  return wss;
}

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

  console.log(`User ${userName} (${userId}) subscribed to file ${fileId}`);
}

async function handleUnsubscribe(ws: ExtendedWebSocket): Promise<void> {
  if (!ws.fileId) return;

  const fileId = ws.fileId;
  const clients = fileClients.get(fileId);

  if (clients) {
    clients.delete(ws);
    if (clients.size === 0) {
      fileClients.delete(fileId);
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

  console.log(`User ${ws.userName} unsubscribed from file ${fileId}`);

  ws.fileId = undefined;
}

async function handleOperation(ws: ExtendedWebSocket, message: WSMessage): Promise<void> {
  if (!ws.fileId || !ws.userId) {
    sendError(ws, 'Not subscribed to any file');
    return;
  }

  const payload = message.payload as { operations: Operation[] };
  const { operations } = payload;

  const processedOps: Operation[] = [];

  for (const op of operations) {
    try {
      // Process operation
      const operation: Operation = {
        ...op,
        fileId: ws.fileId,
        userId: ws.userId,
        timestamp: operationService.getNextTimestamp(),
        clientId: ws.id,
      };

      await operationService.processOperation(operation);
      processedOps.push(operation);

      // Add to batch for broadcasting
      if (!pendingOperations.has(ws.fileId)) {
        pendingOperations.set(ws.fileId, []);
      }
      pendingOperations.get(ws.fileId)!.push(operation);
    } catch (error) {
      console.error('Operation error:', error);
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
  broadcastToFile(ws.fileId, {
    type: 'presence',
    payload: { presence: [presence] },
    fileId: ws.fileId,
  }, ws);
}

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

function handleDisconnect(ws: ExtendedWebSocket): void {
  console.log(`WebSocket client disconnected: ${ws.id}`);
  handleUnsubscribe(ws);
}

function send(ws: ExtendedWebSocket, message: WSMessage): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

function sendError(ws: ExtendedWebSocket, error: string): void {
  send(ws, {
    type: 'error',
    payload: { error },
  });
}

function broadcastToFile(fileId: string, message: WSMessage, exclude?: ExtendedWebSocket): void {
  const clients = fileClients.get(fileId);
  if (!clients) return;

  const data = JSON.stringify(message);
  clients.forEach((client) => {
    if (client !== exclude && client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  });
}

// Get connected users count for a file
export function getFileUserCount(fileId: string): number {
  return fileClients.get(fileId)?.size || 0;
}
