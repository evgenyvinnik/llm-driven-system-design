import { WebSocketServer, WebSocket } from 'ws';
import { Server } from 'http';
import { parse } from 'url';
import { createSubscriber, setPresence, removePresence, setTyping, publishToUser } from './redis.js';
import { query } from '../db/index.js';
import type Redis from 'ioredis';

interface ExtendedWebSocket extends WebSocket {
  userId?: string;
  workspaceId?: string;
  subscriber?: Redis;
  isAlive?: boolean;
}

const clients = new Map<string, Set<ExtendedWebSocket>>();

export function setupWebSocket(server: Server): void {
  const wss = new WebSocketServer({ server, path: '/ws' });

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

    // Parse query params for auth
    const { query: queryParams } = parse(req.url || '', true);
    const { userId, workspaceId } = queryParams as { userId?: string; workspaceId?: string };

    if (!userId || !workspaceId) {
      ws.close(1008, 'Missing userId or workspaceId');
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

async function handleClientMessage(ws: ExtendedWebSocket, message: { type: string; payload: unknown }): Promise<void> {
  const { type, payload } = message;

  switch (type) {
    case 'ping':
      ws.send(JSON.stringify({ type: 'pong' }));
      break;

    case 'typing':
      if (ws.userId && typeof payload === 'object' && payload !== null) {
        const { channelId } = payload as { channelId: string };
        if (channelId) {
          await setTyping(channelId, ws.userId);
          // Broadcast typing indicator to channel members
          const members = await query<{ user_id: string }>(
            'SELECT user_id FROM channel_members WHERE channel_id = $1 AND user_id != $2',
            [channelId, ws.userId]
          );

          for (const member of members.rows) {
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

// Helper to send to specific user (if connected)
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

// Get connected users count
export function getConnectedUsersCount(): number {
  return clients.size;
}
