import { v4 as uuidv4 } from 'uuid';
import type { RedisClientType } from 'redis';
import type { WebSocket, WebSocketServer, RawData } from 'ws';
import type { IncomingMessage, Server } from 'http';
import type { Duplex } from 'stream';
import type { Request, Response } from 'express';
import cookieParser from 'cookie-parser';
import { query } from './database.js';
import { publishMessage, subscribe, unsubscribe, checkRateLimit, getRedisClient, getSession } from './redis.js';
import { logger, logChatEvent } from '../utils/logger.js';
import { incChatMessage, incChatRateLimited, incWsConnection, decWsConnection } from '../utils/metrics.js';
import { checkChatMessageDedup, generateChatMessageId } from '../utils/idempotency.js';
import { createCircuitBreaker } from '../utils/circuitBreaker.js';
import type CircuitBreaker from 'opossum';

interface Badge {
  type: string;
  label?: string;
  tier?: number;
}

interface ClientInfo {
  clientId: string;
  channels: Set<number>;
  userId: number | null;
  username: string;
  role?: string;
}

interface ChatMessage {
  type: string;
  channelId?: unknown;
  text?: string;
  messageId?: string;
}

interface SessionUser {
  userId: number;
  username: string;
  role: string;
}

const CHAT_PATH = '/ws/chat';

interface BroadcastMessage {
  id?: string;
  type: string;
  channelId: string | number;
  userId?: number | null;
  username?: string;
  message?: string;
  badges?: Badge[];
  timestamp?: number;
  viewerCount?: number;
  messageId?: string;
}

// Map of channelId -> Set of WebSocket clients
const channelClients = new Map<number, Set<WebSocket>>();

// Map of WebSocket -> client info
const clientInfo = new Map<WebSocket, ClientInfo>();

// Circuit breaker for Redis publish operations
let redisChatBreaker: CircuitBreaker<[string, unknown], unknown> | null = null;

/** Channel IDs are integers; accepts a number or a numeric string, anything else is rejected. */
function parseChannelId(value: unknown): number | null {
  const id = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  return typeof id === 'number' && Number.isSafeInteger(id) && id > 0 ? id : null;
}

/**
 * Resolves the chat identity from the `session` cookie on the upgrade request,
 * using the same cookie parsing and Redis session lookup as the REST
 * `requireAuth` middleware. Returns null for anonymous viewers.
 */
async function resolveSessionUser(req: IncomingMessage): Promise<SessionUser | null> {
  const request = req as Request;
  await new Promise<void>((resolve) => cookieParser()(request, {} as Response, () => resolve()));
  const sessionId = request.cookies?.session as string | undefined;
  if (!sessionId) return null;

  const userId = await getSession(sessionId);
  if (!userId) return null;

  const result = await query<{ username: string; role: string }>(
    'SELECT username, role FROM users WHERE id = $1',
    [userId]
  );
  const user = result.rows[0];
  return user ? { userId, username: user.username, role: user.role || 'user' } : null;
}

// Local broadcast fallback when Redis is unavailable
function localBroadcast(channelId: number, message: unknown): void {
  const clients = channelClients.get(channelId);
  if (!clients) return;

  const data = JSON.stringify(message);
  clients.forEach(client => {
    if (client.readyState === 1) {
      client.send(data);
    }
  });
}

/**
 * Initializes WebSocket chat server with Redis pub/sub for cross-instance message delivery.
 * The upgrade request's session cookie decides who the socket is: anonymous
 * viewers can join and read chat, only a logged-in session can send messages,
 * and identity fields in client messages are ignored.
 */
function setupChatWebSocket(server: Server, wss: WebSocketServer, _redisClient: RedisClientType): void {
  // Initialize circuit breaker for Redis chat publishing
  redisChatBreaker = createCircuitBreaker(
    'redis-chat-publish',
    async (channel: string, message: unknown) => {
      return publishMessage(channel, message);
    },
    {
      timeout: 1000,
      errorThresholdPercentage: 50,
      resetTimeout: 5000,
      volumeThreshold: 10
    }
  );

  // Set up fallback for when Redis is unavailable
  redisChatBreaker.fallback((channel: string, message: unknown) => {
    logger.warn({ channel }, 'Redis unavailable, using local broadcast only');
    const channelId = Number(channel.replace('chat:', ''));
    localBroadcast(channelId, message);
    return { fallback: true };
  });

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (new URL(req.url ?? '/', 'http://localhost').pathname !== CHAT_PATH) {
      socket.destroy();
      return;
    }
    resolveSessionUser(req)
      .then((user) => {
        wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, user));
      })
      .catch((error: Error) => {
        logger.error({ error: error.message }, 'Chat upgrade session lookup failed');
        socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
        socket.destroy();
      });
  });

  // Subscribe to Redis pub/sub for cross-instance chat
  setupRedisSubscriptions();
}

function onConnection(ws: WebSocket, user: SessionUser | null): void {
  const clientId = uuidv4();
  logger.debug({ client_id: clientId, user_id: user?.userId }, 'Chat client connected');
  incWsConnection();

  const info: ClientInfo = {
    clientId,
    channels: new Set(),
    userId: user?.userId ?? null,
    username: user?.username ?? `Guest_${clientId.slice(0, 6)}`,
    role: user?.role,
  };
  clientInfo.set(ws, info);

  ws.on('message', async (data: RawData) => {
    try {
      const message = JSON.parse(data.toString()) as ChatMessage;
      await handleChatMessage(ws, message);
    } catch (error) {
      logger.error({ error: (error as Error).message, client_id: clientId }, 'Error handling chat message');
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid message format' }));
    }
  });

  ws.on('close', () => {
    const info = clientInfo.get(ws);
    if (info) {
      // Remove from all channel rooms
      info.channels.forEach(channelId => {
        const clients = channelClients.get(channelId);
        if (clients) {
          clients.delete(ws);
          if (clients.size === 0) {
            channelClients.delete(channelId);
          }
        }
      });
      clientInfo.delete(ws);
      logger.debug({ client_id: info.clientId }, 'Chat client disconnected');
      decWsConnection();
    }
  });

  ws.on('error', (error: Error) => {
    logger.error({ error: error.message }, 'WebSocket error');
  });

  sendAuthState(ws, info);
}

async function handleChatMessage(ws: WebSocket, message: ChatMessage): Promise<void> {
  const info = clientInfo.get(ws);
  if (!info) return;

  switch (message.type) {
    case 'auth':
      // Kept for older clients: reports the identity established from the
      // session cookie at connect time. userId/username in the message are ignored.
      sendAuthState(ws, info);
      break;

    case 'join':
      await handleJoin(ws, info, message);
      break;

    case 'leave':
      await handleLeave(ws, info, message);
      break;

    case 'chat':
      await handleChat(ws, info, message);
      break;

    default:
      ws.send(JSON.stringify({ type: 'error', message: 'Unknown message type' }));
  }
}

function sendAuthState(ws: WebSocket, info: ClientInfo): void {
  ws.send(JSON.stringify({
    type: 'auth_success',
    userId: info.userId,
    username: info.username,
    role: info.role,
    ...(info.userId ? {} : { isGuest: true })
  }));
  if (info.userId) logChatEvent('auth', null, { user_id: info.userId, username: info.username });
}

interface RecentMessage {
  id: string;
  message: string;
  username: string;
  badges: string;
  created_at: Date;
  user_id: number;
  display_name: string;
  avatar_url: string;
}

/**
 * Resolves the viewer count to report for a channel.
 *
 * The obvious value — `channelClients.get(channelId).size` — is the number of
 * sockets *this process* holds, which is not the channel's audience. With the
 * `dev:server1/2/3` pattern each instance would report its own slice, so the
 * number shown in chat depended on which instance the viewer happened to hit,
 * and on a single instance it read "1 viewers" beside a player captioned
 * "42,000 watching". `channels.current_viewers` is at least the same figure the
 * rest of the UI shows. A genuinely accurate concurrent count needs a presence
 * service (or per-instance Redis counters with reconciliation); this is the
 * honest approximation, not that.
 * @param channelId - Channel to count viewers for
 * @returns Viewer count from the channel record, falling back to local sockets
 */
async function getChannelViewerCount(channelId: number): Promise<number> {
  const result = await query<{ current_viewers: number }>(
    'SELECT current_viewers FROM channels WHERE id = $1',
    [channelId]
  );
  const stored = result.rows[0]?.current_viewers;
  return stored && stored > 0 ? stored : (channelClients.get(channelId)?.size ?? 0);
}

async function handleJoin(ws: WebSocket, info: ClientInfo, message: ChatMessage): Promise<void> {
  const channelId = parseChannelId(message.channelId);
  if (!channelId) return;

  // Add to channel room
  if (!channelClients.has(channelId)) {
    channelClients.set(channelId, new Set());
    // Subscribe to Redis channel for this room
    await subscribe(`chat:${channelId}`, (msg: unknown) => {
      broadcastToChannel(channelId, msg as BroadcastMessage);
    });
  }
  channelClients.get(channelId)!.add(ws);
  info.channels.add(channelId);

  // Fetch recent messages
  const recentMessages = await query<RecentMessage>(`
    SELECT cm.id, cm.message, cm.username, cm.badges, cm.created_at,
           cm.user_id, u.display_name, u.avatar_url
    FROM chat_messages cm
    LEFT JOIN users u ON cm.user_id = u.id
    WHERE cm.channel_id = $1 AND cm.is_deleted = FALSE
    ORDER BY cm.created_at DESC
    LIMIT 50
  `, [channelId]);

  const viewerCount = await getChannelViewerCount(channelId);

  ws.send(JSON.stringify({
    type: 'joined',
    channelId,
    recentMessages: recentMessages.rows.reverse(),
    viewerCount
  }));

  // Notify room of new viewer
  broadcastToChannel(channelId, {
    type: 'viewer_update',
    channelId,
    viewerCount
  });

  logChatEvent('join', channelId, { user_id: info.userId, username: info.username });
}

async function handleLeave(ws: WebSocket, info: ClientInfo, message: ChatMessage): Promise<void> {
  const channelId = parseChannelId(message.channelId);
  if (!channelId) return;

  const clients = channelClients.get(channelId);
  if (clients) {
    clients.delete(ws);
    info.channels.delete(channelId);

    if (clients.size === 0) {
      channelClients.delete(channelId);
      await unsubscribe(`chat:${channelId}`);
    } else {
      // Notify room of viewer leaving
      broadcastToChannel(channelId, {
        type: 'viewer_update',
        channelId,
        viewerCount: await getChannelViewerCount(channelId)
      });
    }
  }

  ws.send(JSON.stringify({ type: 'left', channelId }));
  logChatEvent('leave', channelId, { user_id: info.userId });
}

async function handleChat(ws: WebSocket, info: ClientInfo, message: ChatMessage): Promise<void> {
  const channelId = parseChannelId(message.channelId);
  const { text, messageId: clientMessageId } = message;

  if (!channelId || typeof text !== 'string' || text.trim().length === 0) {
    ws.send(JSON.stringify({ type: 'error', message: 'Invalid message' }));
    return;
  }

  // Only a logged-in session may chat. Anonymous guests read only: otherwise a
  // banned user could keep chatting just by dropping their identity.
  if (!info.userId) {
    ws.send(JSON.stringify({ type: 'error', message: 'Log in to chat' }));
    return;
  }

  // The message must target a channel this socket has joined
  if (!info.channels.has(channelId)) {
    ws.send(JSON.stringify({ type: 'error', message: 'Join the channel before chatting' }));
    return;
  }

  // Generate or use provided message ID for deduplication
  const messageId = clientMessageId || generateChatMessageId(info.userId || info.clientId);

  // Check for duplicate message (idempotency)
  const redis = getRedisClient();
  const dedupResult = await checkChatMessageDedup(redis, channelId, messageId);
  if (dedupResult.dropped) {
    logger.debug({
      channel_id: channelId,
      message_id: messageId,
      user_id: info.userId
    }, 'Duplicate chat message dropped');
    // Silently drop duplicate - client may have retried
    return;
  }

  // Check rate limit
  const rateCheck = await checkRateLimit(info.userId || info.clientId, channelId, 1);
  if (!rateCheck.allowed) {
    incChatRateLimited();
    ws.send(JSON.stringify({
      type: 'error',
      message: `Slow down! Wait ${Math.ceil((rateCheck.waitMs || 0) / 1000)}s`
    }));
    return;
  }

  // Check if user is banned (timeouts are bans with an expiry)
  if (info.userId) {
    const banCheck = await query(`
      SELECT 1 FROM channel_bans
      WHERE channel_id = $1 AND user_id = $2
      AND (expires_at IS NULL OR expires_at > NOW())
    `, [channelId, info.userId]);

    if (banCheck.rows.length > 0) {
      ws.send(JSON.stringify({ type: 'error', message: 'You are banned from this channel' }));
      return;
    }
  }

  // Build badges array
  const badges: Badge[] = [];
  if (info.role === 'admin') badges.push({ type: 'admin', label: 'Admin' });
  if (info.role === 'moderator') badges.push({ type: 'mod', label: 'Moderator' });

  // Check if subscriber
  if (info.userId) {
    const subCheck = await query<{ tier: number }>(`
      SELECT tier FROM subscriptions
      WHERE user_id = $1 AND channel_id = $2 AND expires_at > NOW()
    `, [info.userId, channelId]);
    if (subCheck.rows.length > 0) {
      badges.push({ type: 'subscriber', tier: subCheck.rows[0].tier });
    }

    // Check if moderator
    const modCheck = await query(`
      SELECT 1 FROM channel_moderators
      WHERE channel_id = $1 AND user_id = $2
    `, [channelId, info.userId]);
    if (modCheck.rows.length > 0) {
      badges.push({ type: 'mod', label: 'Mod' });
    }
  }

  const chatMessage: BroadcastMessage = {
    id: messageId,
    type: 'chat',
    channelId,
    userId: info.userId,
    username: info.username,
    message: text.slice(0, 500), // Limit message length
    badges,
    timestamp: Date.now()
  };

  // Store in database
  if (info.userId) {
    await query(`
      INSERT INTO chat_messages (channel_id, user_id, username, message, badges)
      VALUES ($1, $2, $3, $4, $5)
    `, [channelId, info.userId, info.username, chatMessage.message, JSON.stringify(badges)]);
  }

  // Publish to Redis for cross-instance delivery (with circuit breaker protection)
  try {
    if (redisChatBreaker) {
      await redisChatBreaker.fire(`chat:${channelId}`, chatMessage);
    }
  } catch (error) {
    // Circuit breaker is open or fallback was used
    logger.warn({
      channel_id: channelId,
      error: (error as Error).message
    }, 'Chat publish via circuit breaker fallback');
  }

  // Update metrics
  incChatMessage(channelId);
}

function broadcastToChannel(channelId: number, message: BroadcastMessage): void {
  const clients = channelClients.get(channelId);
  if (!clients) return;

  const data = JSON.stringify(message);
  clients.forEach(client => {
    if (client.readyState === 1) { // WebSocket.OPEN
      client.send(data);
    }
  });
}

function setupRedisSubscriptions(): void {
  // This is already handled per-channel in handleJoin
  // but we could add global subscriptions here
}

export { setupChatWebSocket };
