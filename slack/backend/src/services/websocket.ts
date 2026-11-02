/**
 * @fileoverview WebSocket service for real-time messaging.
 * Manages WebSocket connections, authenticates users, handles presence,
 * and routes messages through Redis pub/sub for multi-instance support.
 */

import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage, Server } from 'http';
import type { Duplex } from 'stream';
import type { Request, RequestHandler, Response } from 'express';
import { createSubscriber, setPresence, removePresence, setTyping, publishToUser } from './redis.js';
import { query } from '../db/index.js';
import type Redis from 'ioredis';

/**
 * Extended WebSocket interface with user session data and Redis subscriber.
 */
interface ExtendedWebSocket extends WebSocket {
  /** The authenticated user's ID */
  userId?: string;
  /** The workspace the user is connected to */
  workspaceId?: string;
  /** Redis subscriber for receiving messages */
  subscriber?: Redis;
  /** Heartbeat flag for connection health checking */
  isAlive?: boolean;
}

/**
 * Map of user IDs to their active WebSocket connections.
 * Supports multiple connections per user (e.g., multiple browser tabs).
 */
const clients = new Map<string, Set<ExtendedWebSocket>>();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Sets up the WebSocket server on the provided HTTP server.
 * Handles connection authentication, heartbeat monitoring, message routing,
 * and presence updates. Each user subscribes to their own Redis pub/sub channel.
 *
 * Identity comes from the Express session cookie on the upgrade request,
 * resolved by the same session middleware the REST API uses. A `userId` in the
 * query string is ignored; sockets without a session are refused with 401.
 * @param server - The HTTP server to attach the WebSocket server to
 * @param sessionMiddleware - The express-session middleware instance used by the REST API
 */
export function setupWebSocket(server: Server, sessionMiddleware: RequestHandler): void {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (new URL(req.url ?? '/', 'http://localhost').pathname !== '/ws') {
      socket.destroy();
      return;
    }
    sessionMiddleware(req as Request, {} as Response, () => {
      if (!(req as Request).session?.userId) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    });
  });

  // Heartbeat interval
  const heartbeatInterval = setInterval(() => {
    wss.clients.forEach((ws: ExtendedWebSocket) => {
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

  wss.on('connection', async (ws: ExtendedWebSocket, req) => {
    ws.isAlive = true;

    ws.on('pong', () => {
      ws.isAlive = true;
    });

    // The user is the session's; only the workspace is chosen by the client
    // (falling back to the session's selected workspace), and it is checked below.
    const session = (req as Request).session;
    const userId = session.userId;
    const workspaceId =
      new URL(req.url ?? '/', 'http://localhost').searchParams.get('workspaceId') || session.workspaceId;

    if (!userId || !workspaceId || !UUID_RE.test(workspaceId)) {
      ws.close(1008, 'Missing or invalid workspaceId');
      return;
    }

    // Verify user is member of workspace
    const membership = await query(
      'SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND user_id = $2',
      [workspaceId, userId]
    );

    if (membership.rows.length === 0) {
      ws.close(1008, 'Not a member of this workspace');
      return;
    }

    ws.userId = userId;
    ws.workspaceId = workspaceId;

    // Track connection
    if (!clients.has(userId)) {
      clients.set(userId, new Set());
    }
    clients.get(userId)!.add(ws);

    // Set presence
    await setPresence(workspaceId, userId, 'online');

    // Subscribe to user's message channel
    const subscriber = createSubscriber();
    ws.subscriber = subscriber;

    await subscriber.subscribe(`user:${userId}:messages`);

    subscriber.on('message', (channel, data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    });

    // Broadcast presence to workspace members
    await broadcastPresence(workspaceId, userId, 'online');

    console.log(`WebSocket connected: user=${userId}, workspace=${workspaceId}`);

    // Handle incoming messages
    ws.on('message', async (data) => {
      try {
        const message = JSON.parse(data.toString());
        await handleClientMessage(ws, message);
      } catch (error) {
        console.error('WebSocket message error:', error);
      }
    });

    ws.on('close', async () => {
      // Cleanup
      clients.get(userId)?.delete(ws);
      if (clients.get(userId)?.size === 0) {
        clients.delete(userId);
        // Only remove presence if no other connections
        await removePresence(workspaceId, userId);
        await broadcastPresence(workspaceId, userId, 'offline');
      }

      if (ws.subscriber) {
        ws.subscriber.disconnect();
      }

      console.log(`WebSocket disconnected: user=${userId}`);
    });

    ws.on('error', (error) => {
      console.error('WebSocket error:', error);
    });

    // Send welcome message
    ws.send(JSON.stringify({
      type: 'connected',
      payload: { userId, workspaceId },
    }));
  });
}

/**
 * Processes incoming WebSocket messages from clients.
 * Handles ping/pong heartbeats, typing indicators, and presence updates.
 * @param ws - The WebSocket connection that sent the message
 * @param message - The parsed message object with type and payload
 */
async function handleClientMessage(ws: ExtendedWebSocket, message: { type: string; payload: unknown }): Promise<void> {
  const { type, payload } = message;

  switch (type) {
    case 'ping':
      ws.send(JSON.stringify({ type: 'pong' }));
      break;

    case 'typing':
      if (ws.userId && typeof payload === 'object' && payload !== null) {
        const { channelId } = payload as { channelId?: unknown };
        if (typeof channelId === 'string' && UUID_RE.test(channelId)) {
          // Same rule as sending a message: only channel members may type in it.
          const members = await query<{ user_id: string }>(
            'SELECT user_id FROM channel_members WHERE channel_id = $1',
            [channelId]
          );
          if (!members.rows.some((member) => member.user_id === ws.userId)) {
            ws.send(JSON.stringify({ type: 'error', payload: { message: 'Not a member of this channel', channelId } }));
            break;
          }

          await setTyping(channelId, ws.userId);
          // Broadcast typing indicator to the other channel members
          for (const member of members.rows) {
            if (member.user_id === ws.userId) continue;
            await publishToUser(member.user_id, {
              type: 'typing',
              payload: { channelId, userId: ws.userId },
            });
          }
        }
      }
      break;

    case 'presence':
      if (ws.userId && ws.workspaceId && typeof payload === 'object' && payload !== null) {
        const { status } = payload as { status: 'online' | 'away' };
        if (status === 'online' || status === 'away') {
          await setPresence(ws.workspaceId, ws.userId, status);
          await broadcastPresence(ws.workspaceId, ws.userId, status);
        }
      }
      break;

    default:
      console.log('Unknown message type:', type);
  }
}

/**
 * Broadcasts a presence update to all members of a workspace.
 * Notifies other users when someone comes online, goes away, or disconnects.
 * @param workspaceId - The workspace where the presence change occurred
 * @param userId - The user whose presence changed
 * @param status - The new presence status ('online', 'away', or 'offline')
 */
async function broadcastPresence(workspaceId: string, userId: string, status: string): Promise<void> {
  try {
    // Get workspace members
    const members = await query<{ user_id: string }>(
      'SELECT user_id FROM workspace_members WHERE workspace_id = $1 AND user_id != $2',
      [workspaceId, userId]
    );

    // Get user info
    const userResult = await query(
      'SELECT username, display_name, avatar_url FROM users WHERE id = $1',
      [userId]
    );

    const user = userResult.rows[0];

    for (const member of members.rows) {
      await publishToUser(member.user_id, {
        type: 'presence',
        payload: {
          userId,
          status,
          user: user || null,
        },
      });
    }
  } catch (error) {
    console.error('Broadcast presence error:', error);
  }
}

/**
 * Sends a message directly to a user if they have an active WebSocket connection.
 * Delivers to all of the user's connected clients (multiple tabs/devices).
 * Used for direct delivery without going through Redis pub/sub.
 * @param userId - The target user's unique identifier
 * @param message - The message payload to send (will be JSON stringified)
 */
export function sendToUser(userId: string, message: unknown): void {
  const userClients = clients.get(userId);
  if (userClients) {
    const data = JSON.stringify(message);
    userClients.forEach(ws => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    });
  }
}

/**
 * Returns the number of unique users currently connected via WebSocket.
 * Useful for monitoring and debugging connection state.
 * @returns Count of unique connected user IDs
 */
export function getConnectedUsersCount(): number {
  return clients.size;
}
