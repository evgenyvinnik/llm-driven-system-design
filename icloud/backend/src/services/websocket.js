import { redis } from '../db.js';

// Store active WebSocket connections by user
const userConnections = new Map(); // userId -> Set<WebSocket>

export function setupWebSocket(wss) {
  wss.on('connection', async (ws, req) => {
    console.log('WebSocket connection attempt');

    // Extract token from query string
    const url = new URL(req.url, 'http://localhost');
    const token = url.searchParams.get('token');

    if (!token) {
      ws.close(4001, 'Authentication required');
      return;
    }

    // Validate token
    const sessionData = await redis.get(`session:${token}`);

    if (!sessionData) {
      ws.close(4001, 'Invalid token');
      return;
    }

    const session = JSON.parse(sessionData);
    const userId = session.user.id;
    const deviceId = session.deviceId;

    // Store connection
    if (!userConnections.has(userId)) {
      userConnections.set(userId, new Set());
    }
    userConnections.get(userId).add(ws);

    // Add metadata to connection
    ws.userId = userId;
    ws.deviceId = deviceId;

    console.log(`WebSocket connected: user=${userId}, device=${deviceId}`);

    // Send connection confirmation
    ws.send(JSON.stringify({
      type: 'connected',
      userId,
      deviceId,
    }));

    // Handle messages
    ws.on('message', async (data) => {
      try {
        const message = JSON.parse(data.toString());
        await handleMessage(ws, message);
      } catch (error) {
        console.error('WebSocket message error:', error);
        ws.send(JSON.stringify({ type: 'error', message: error.message }));
      }
    });

    // Handle disconnection
    ws.on('close', () => {
      console.log(`WebSocket disconnected: user=${userId}, device=${deviceId}`);
      const userConns = userConnections.get(userId);
      if (userConns) {
        userConns.delete(ws);
        if (userConns.size === 0) {
          userConnections.delete(userId);
        }
      }
    });

    // Handle errors
    ws.on('error', (error) => {
      console.error(`WebSocket error for user=${userId}:`, error);
    });

    // Ping/pong for connection health
    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });
  });

  // Heartbeat interval
  const heartbeatInterval = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (!ws.isAlive) {
        return ws.terminate();
      }
      ws.isAlive = false;
      ws.ping();
    });
  }, 30000);

  wss.on('close', () => {
    clearInterval(heartbeatInterval);
  });
}

/**
 * Handle incoming WebSocket messages
 */
async function handleMessage(ws, message) {
  const { type, data } = message;

  switch (type) {
    case 'ping':
      ws.send(JSON.stringify({ type: 'pong' }));
      break;

    case 'subscribe':
      // Subscribe to specific file changes
      if (data?.fileId) {
        ws.subscribedFiles = ws.subscribedFiles || new Set();
        ws.subscribedFiles.add(data.fileId);
      }
      break;

    case 'unsubscribe':
      if (data?.fileId && ws.subscribedFiles) {
        ws.subscribedFiles.delete(data.fileId);
      }
      break;

    case 'sync_request':
      // Client requesting immediate sync check
      ws.send(JSON.stringify({
        type: 'sync_required',
        timestamp: new Date().toISOString(),
      }));
      break;

    default:
      console.log(`Unknown message type: ${type}`);
  }
}

/**
 * Broadcast a message to all connections for a specific user
 */
export function broadcastToUser(userId, message, excludeDeviceId = null) {
  const connections = userConnections.get(userId);

  if (!connections) return;

  const messageStr = JSON.stringify(message);

  for (const ws of connections) {
    // Skip the device that initiated the change
    if (excludeDeviceId && ws.deviceId === excludeDeviceId) {
      continue;
    }

    if (ws.readyState === 1) { // WebSocket.OPEN
      ws.send(messageStr);
    }
  }
}

/**
 * Broadcast to all subscribers of a specific file
 */
export function broadcastToFileSubscribers(fileId, message, excludeDeviceId = null) {
  const messageStr = JSON.stringify(message);

  for (const [userId, connections] of userConnections) {
    for (const ws of connections) {
      if (
        ws.subscribedFiles?.has(fileId) &&
        (!excludeDeviceId || ws.deviceId !== excludeDeviceId) &&
        ws.readyState === 1
      ) {
        ws.send(messageStr);
      }
    }
  }
}

/**
 * Get count of active connections for a user
 */
export function getUserConnectionCount(userId) {
  return userConnections.get(userId)?.size || 0;
}

/**
 * Get all connected devices for a user
 */
export function getConnectedDevices(userId) {
  const connections = userConnections.get(userId);
  if (!connections) return [];

  return Array.from(connections).map(ws => ws.deviceId).filter(Boolean);
}
