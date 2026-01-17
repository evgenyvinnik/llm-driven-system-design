/**
 * @fileoverview WebSocket server for real-time collaboration.
 * Handles page subscriptions, operation broadcasting, and presence tracking.
 * Uses Hybrid Logical Clocks (HLC) for causal ordering of operations.
 */

import { WebSocketServer, WebSocket } from 'ws';
import { Server } from 'http';
import { v4 as uuidv4 } from 'uuid';
import { getSession, setPresence, getPresence, removePresence } from '../models/redis.js';
import pool from '../models/db.js';
import type { WSMessage, Presence, Operation } from '../types/index.js';
import { generateHLC, hlcToNumber, initHLC } from '../utils/hlc.js';

/** Unique identifier for this server instance (used in HLC) */
const serverId = uuidv4().slice(0, 8);
initHLC(serverId);

/**
 * Represents an authenticated WebSocket connection.
 * Tracks user identity, current page subscription, and activity timestamp.
 */
interface ClientConnection {
  ws: WebSocket;
  userId: string;
  userName: string;
  pageId: string | null;
  lastSeen: number;
}

/** Map of client ID to connection data */
const clients = new Map<string, ClientConnection>();

/** Map of page ID to set of subscribed client IDs */
const pageSubscriptions = new Map<string, Set<string>>();

/**
 * Sets up the WebSocket server on an existing HTTP server.
 * Handles authentication, message routing, and connection lifecycle.
 *
 * @param server - The HTTP server to attach WebSocket to
 * @returns The configured WebSocketServer instance
 */
export function setupWebSocket(server: Server): WebSocketServer {
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', async (ws, req) => {
    const clientId = uuidv4();
    let connection: ClientConnection | null = null;

    console.log(`WebSocket client connected: ${clientId}`);

    // Authenticate from query params or cookies
    const url = new URL(req.url || '', `http://${req.headers.host}`);
    const token = url.searchParams.get('token');

    if (!token) {
      ws.send(JSON.stringify({ type: 'error', payload: { message: 'Authentication required' } }));
      ws.close();
      return;
    }

    // Validate session
    const userId = await getSession(token);
    if (!userId) {
      ws.send(JSON.stringify({ type: 'error', payload: { message: 'Invalid session' } }));
      ws.close();
      return;
    }

    // Get user info
    const userResult = await pool.query(
      'SELECT id, name FROM users WHERE id = $1',
      [userId]
    );

    if (userResult.rows.length === 0) {
      ws.send(JSON.stringify({ type: 'error', payload: { message: 'User not found' } }));
      ws.close();
      return;
    }

    const user = userResult.rows[0];

    connection = {
      ws,
      userId: user.id,
      userName: user.name,
      pageId: null,
      lastSeen: Date.now(),
    };

    clients.set(clientId, connection);

    // Send welcome message
    ws.send(JSON.stringify({
      type: 'connected',
      payload: {
        clientId,
        userId: user.id,
        userName: user.name,
      },
    }));

    // Handle incoming messages
    ws.on('message', async (data) => {
      try {
        const message: WSMessage = JSON.parse(data.toString());
        await handleMessage(clientId, message);
      } catch (error) {
        console.error('WebSocket message error:', error);
        ws.send(JSON.stringify({ type: 'error', payload: { message: 'Invalid message format' } }));
      }
    });

    // Handle disconnect
    ws.on('close', async () => {
      console.log(`WebSocket client disconnected: ${clientId}`);

      const conn = clients.get(clientId);
      if (conn?.pageId) {
        // Remove from page subscription
        const subscribers = pageSubscriptions.get(conn.pageId);
        if (subscribers) {
          subscribers.delete(clientId);
          if (subscribers.size === 0) {
            pageSubscriptions.delete(conn.pageId);
          }
        }

        // Remove presence
        await removePresence(conn.pageId, conn.userId);

        // Notify others
        broadcastToPage(conn.pageId, {
          type: 'presence',
          payload: {
            action: 'leave',
            userId: conn.userId,
            userName: conn.userName,
          },
        }, clientId);
      }

      clients.delete(clientId);
    });

    ws.on('error', (error) => {
      console.error(`WebSocket error for ${clientId}:`, error);
    });
  });

  // Periodic cleanup of stale connections
  setInterval(() => {
    const now = Date.now();
    for (const [clientId, conn] of clients) {
      if (now - conn.lastSeen > 60000) { // 1 minute timeout
        console.log(`Cleaning up stale connection: ${clientId}`);
        conn.ws.close();
        clients.delete(clientId);
      }
    }
  }, 30000);

  return wss;
}

/**
 * Routes incoming WebSocket messages to appropriate handlers.
 * Updates the connection's lastSeen timestamp for timeout tracking.
 *
 * @param clientId - The unique client connection ID
 * @param message - The parsed WebSocket message
 */
async function handleMessage(clientId: string, message: WSMessage): Promise<void> {
  const conn = clients.get(clientId);
  if (!conn) return;

  conn.lastSeen = Date.now();

  switch (message.type) {
    case 'subscribe':
      await handleSubscribe(clientId, message.payload as { pageId: string });
      break;

    case 'unsubscribe':
      await handleUnsubscribe(clientId);
      break;

    case 'operation':
      await handleOperation(clientId, message.payload as Operation);
      break;

    case 'presence':
      await handlePresenceUpdate(clientId, message.payload as Partial<Presence>);
      break;

    case 'sync':
      await handleSync(clientId, message.payload as { since: number });
      break;

    default:
      conn.ws.send(JSON.stringify({ type: 'error', payload: { message: 'Unknown message type' } }));
  }
}

/**
 * Subscribes a client to real-time updates for a page.
 * Verifies access permissions and broadcasts presence to other viewers.
 *
 * @param clientId - The client connection ID
 * @param payload - Contains the pageId to subscribe to
 */
async function handleSubscribe(clientId: string, payload: { pageId: string }): Promise<void> {
  const conn = clients.get(clientId);
  if (!conn) return;

  const { pageId } = payload;

  // Verify page access
  const pageResult = await pool.query(
    'SELECT workspace_id FROM pages WHERE id = $1',
    [pageId]
  );

  if (pageResult.rows.length === 0) {
    conn.ws.send(JSON.stringify({ type: 'error', payload: { message: 'Page not found' } }));
    return;
  }

  const memberCheck = await pool.query(
    `SELECT role FROM workspace_members
     WHERE workspace_id = $1 AND user_id = $2`,
    [pageResult.rows[0].workspace_id, conn.userId]
  );

  if (memberCheck.rows.length === 0) {
    conn.ws.send(JSON.stringify({ type: 'error', payload: { message: 'Access denied' } }));
    return;
  }

  // Unsubscribe from previous page
  if (conn.pageId) {
    await handleUnsubscribe(clientId);
  }

  // Subscribe to new page
  conn.pageId = pageId;

  if (!pageSubscriptions.has(pageId)) {
    pageSubscriptions.set(pageId, new Set());
  }
  pageSubscriptions.get(pageId)!.add(clientId);

  // Update presence in Redis
  const presenceData: Presence = {
    user_id: conn.userId,
    user_name: conn.userName,
    page_id: pageId,
    last_seen: Date.now(),
  };
  await setPresence(pageId, conn.userId, JSON.stringify(presenceData));

  // Get current presence on page
  const presence = await getPresence(pageId);
  const activeUsers = Object.values(presence).map((p) => JSON.parse(p) as Presence);

  // Send subscription confirmation with presence
  conn.ws.send(JSON.stringify({
    type: 'subscribed',
    payload: {
      pageId,
      presence: activeUsers,
    },
  }));

  // Notify others of new presence
  broadcastToPage(pageId, {
    type: 'presence',
    payload: {
      action: 'join',
      userId: conn.userId,
      userName: conn.userName,
    },
  }, clientId);
}

/**
 * Unsubscribes a client from the current page.
 * Removes presence data and notifies other viewers.
 *
 * @param clientId - The client connection ID
 */
async function handleUnsubscribe(clientId: string): Promise<void> {
  const conn = clients.get(clientId);
  if (!conn || !conn.pageId) return;

  const pageId = conn.pageId;

  // Remove from subscription
  const subscribers = pageSubscriptions.get(pageId);
  if (subscribers) {
    subscribers.delete(clientId);
    if (subscribers.size === 0) {
      pageSubscriptions.delete(pageId);
    }
  }

  // Remove presence
  await removePresence(pageId, conn.userId);

  // Notify others
  broadcastToPage(pageId, {
    type: 'presence',
    payload: {
      action: 'leave',
      userId: conn.userId,
      userName: conn.userName,
    },
  }, clientId);

  conn.pageId = null;

  conn.ws.send(JSON.stringify({
    type: 'unsubscribed',
    payload: { pageId },
  }));
}

/**
 * Handles an editing operation from a client.
 * Persists to database with HLC timestamp and broadcasts to other subscribers.
 *
 * @param clientId - The client connection ID
 * @param operation - The block operation (insert, update, delete, move)
 */
async function handleOperation(clientId: string, operation: Operation): Promise<void> {
  const conn = clients.get(clientId);
  if (!conn || !conn.pageId) {
    conn?.ws.send(JSON.stringify({ type: 'error', payload: { message: 'Not subscribed to a page' } }));
    return;
  }

  // Generate HLC timestamp
  const hlc = generateHLC();
  const timestamp = hlcToNumber(hlc);

  // Persist operation
  try {
    await pool.query(
      `INSERT INTO operations (id, page_id, block_id, type, data, timestamp, author_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        operation.id || uuidv4(),
        conn.pageId,
        operation.block_id,
        operation.type,
        JSON.stringify(operation.data),
        timestamp,
        conn.userId,
      ]
    );

    // Acknowledge to sender
    conn.ws.send(JSON.stringify({
      type: 'ack',
      payload: {
        operationId: operation.id,
        timestamp,
      },
    }));

    // Broadcast to other subscribers
    broadcastToPage(conn.pageId, {
      type: 'operation',
      payload: {
        ...operation,
        timestamp,
        author_id: conn.userId,
        author_name: conn.userName,
      },
    }, clientId);
  } catch (error) {
    console.error('Operation persistence error:', error);
    conn.ws.send(JSON.stringify({ type: 'error', payload: { message: 'Failed to persist operation' } }));
  }
}

/**
 * Updates a client's cursor position and broadcasts to other viewers.
 * Used for showing collaborative cursors in the editor.
 *
 * @param clientId - The client connection ID
 * @param payload - Contains optional cursor position (block_id, offset)
 */
async function handlePresenceUpdate(clientId: string, payload: Partial<Presence>): Promise<void> {
  const conn = clients.get(clientId);
  if (!conn || !conn.pageId) return;

  // Update presence in Redis
  const presenceData: Presence = {
    user_id: conn.userId,
    user_name: conn.userName,
    page_id: conn.pageId,
    cursor_position: payload.cursor_position,
    last_seen: Date.now(),
  };
  await setPresence(conn.pageId, conn.userId, JSON.stringify(presenceData));

  // Broadcast cursor position to others
  broadcastToPage(conn.pageId, {
    type: 'presence',
    payload: {
      action: 'update',
      userId: conn.userId,
      userName: conn.userName,
      cursor_position: payload.cursor_position,
    },
  }, clientId);
}

/**
 * Handles a sync request from a client returning to a page.
 * Returns all operations since the given timestamp for catching up.
 *
 * @param clientId - The client connection ID
 * @param payload - Contains the timestamp to sync from
 */
async function handleSync(clientId: string, payload: { since: number }): Promise<void> {
  const conn = clients.get(clientId);
  if (!conn || !conn.pageId) {
    conn?.ws.send(JSON.stringify({ type: 'error', payload: { message: 'Not subscribed to a page' } }));
    return;
  }

  // Get operations since timestamp
  const result = await pool.query(
    `SELECT * FROM operations
     WHERE page_id = $1 AND timestamp > $2
     ORDER BY timestamp`,
    [conn.pageId, payload.since]
  );

  conn.ws.send(JSON.stringify({
    type: 'sync',
    payload: {
      operations: result.rows,
      timestamp: Date.now(),
    },
  }));
}

/**
 * Broadcasts a message to all clients subscribed to a page.
 * Optionally excludes a specific client (e.g., the sender).
 *
 * @param pageId - The page to broadcast to
 * @param message - The message object to send
 * @param excludeClientId - Optional client ID to exclude from broadcast
 */
function broadcastToPage(pageId: string, message: WSMessage, excludeClientId?: string): void {
  const subscribers = pageSubscriptions.get(pageId);
  if (!subscribers) return;

  const messageStr = JSON.stringify(message);

  for (const clientId of subscribers) {
    if (clientId === excludeClientId) continue;

    const conn = clients.get(clientId);
    if (conn && conn.ws.readyState === WebSocket.OPEN) {
      conn.ws.send(messageStr);
    }
  }
}
