import { WebSocketServer, WebSocket, RawData } from 'ws';
import { Server as HttpServer, IncomingMessage } from 'http';
import { randomUUID } from 'crypto';
import { authenticateWs, User, WsAuthResult } from '../middleware/auth.js';
import {
  sendMessage,
  markAsRead,
  addReaction,
  removeReaction,
  getMessage,
  getInboxBatch,
  acknowledgeDelivery,
  NotParticipantError,
  IdempotencyConflictError,
  MAX_CONTENT_LENGTH,
} from './messages.js';
import { isParticipant, getParticipantIds, getConversationPeerIds } from './conversations.js';
import { subClient, setTyping, touchPresence, dropPresence } from '../redis.js';
import {
  CHANNELS,
  publishNewMessage,
  publishTyping,
  publishReadReceipt,
  publishDeliveryReceipts,
  publishReaction,
  publishPresence,
  NewMessageEvent,
  TypingEvent,
  ReadReceiptEvent,
  DeliveryReceiptEvent,
  ReactionEvent,
  PresenceEvent,
  ControlEvent,
} from './realtime.js';
import { ConnectionRegistry } from '../shared/connection-registry.js';
import rateLimiter, { MESSAGE_RATE_LIMIT, messageRateKey } from '../shared/rate-limiter.js';
import { createLogger } from '../shared/logger.js';
import { websocketConnections, rateLimitExceeded } from '../shared/metrics.js';

const logger = createLogger('websocket');

interface ClientSocket extends WebSocket {
  isAlive: boolean;
  /** Unique per socket; a device with two tabs has two connections. */
  connectionId: string;
  /** Inbound frames are processed one at a time, in arrival order. */
  queue: Promise<void>;
}

interface ClientFrame {
  type: string;
  [key: string]: unknown;
}

const MAX_ACK_IDS = 500;
const CLIENT_CONTENT_TYPES = new Set(['text', 'image', 'video', 'file']);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isUuid = (value: unknown): value is string => typeof value === 'string' && UUID_PATTERN.test(value);

// Sockets held by this instance: userId -> deviceId -> sockets
const registry = new ConnectionRegistry<ClientSocket>();
let heartbeatInterval: ReturnType<typeof setInterval> | null = null;

function send(ws: ClientSocket, payload: object): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

/** Initializes the WebSocket server: authentication, delivery, receipts, presence. */
export function setupWebSocket(server: HttpServer): WebSocketServer {
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });

  // Every instance hears every event and forwards it to the sockets it holds
  subClient.subscribe(...CHANNELS).catch((error: Error) => {
    logger.error({ error }, 'Failed to subscribe to pub/sub channels');
  });
  subClient.on('message', (channel: string, raw: string) => {
    try {
      handlePubSubMessage(channel, JSON.parse(raw));
    } catch (error) {
      logger.error({ error, channel }, 'Invalid pub/sub payload');
    }
  });

  wss.on('connection', (rawWs: WebSocket, req: IncomingMessage) => {
    const ws = rawWs as ClientSocket;
    ws.isAlive = true;
    ws.connectionId = randomUUID();

    const url = new URL(req.url || '', `http://${req.headers.host}`);
    const ready: Promise<WsAuthResult | null> = authenticateWs(url.searchParams.get('token')).catch(
      (error: Error) => {
        logger.error({ error }, 'WebSocket authentication failed');
        return null;
      }
    );

    // Start the per-socket queue with authentication and the initial sync.
    ws.queue = ready
      .then(async (auth) => {
        if (!auth) {
          ws.close(4001, 'Unauthorized');
          return;
        }
        await onAuthenticated(ws, auth);
      })
      .catch((error: Error) => logger.error({ error }, 'WebSocket setup failed'));

    // Attach the frame handler now, not after the async authentication: the
    // client flushes queued sends the moment the socket opens, and ws drops
    // frames that arrive before a 'message' listener exists. Chaining every
    // frame on ws.queue also keeps one device's sends in order, so its
    // messages get seq numbers in the order the user typed them.
    ws.on('message', (data: RawData) => {
      ws.queue = ws.queue
        .then(async () => {
          const auth = await ready;
          if (!auth || ws.readyState !== WebSocket.OPEN) return;
          await handleFrame(ws, auth.user, auth.deviceId, data);
        })
        .catch((error: Error) => logger.error({ error }, 'WebSocket frame handling failed'));
    });

    ws.on('pong', () => {
      ws.isAlive = true;
      ready
        .then((auth) => auth && touchPresence(auth.user.id, ws.connectionId))
        .catch(() => undefined);
    });

    ws.on('close', () => {
      ws.queue = ws.queue
        .then(async () => {
          const auth = await ready;
          if (auth) await onClose(ws, auth);
        })
        .catch((error: Error) => logger.error({ error }, 'WebSocket cleanup failed'));
    });
  });

  // Heartbeat: a socket to a device that dropped off the network stays
  // "open" on the server until a ping goes unanswered.
  heartbeatInterval = setInterval(() => {
    wss.clients.forEach((client) => {
      const ws = client as ClientSocket;
      if (!ws.isAlive) {
        ws.terminate();
        return;
      }
      ws.isAlive = false;
      ws.ping();
    });
  }, parseInt(process.env.WS_HEARTBEAT_INTERVAL || '30000'));

  wss.on('close', () => {
    if (heartbeatInterval) clearInterval(heartbeatInterval);
  });

  return wss;
}

async function onAuthenticated(ws: ClientSocket, { user, deviceId }: WsAuthResult): Promise<void> {
  if (ws.readyState !== WebSocket.OPEN) return;

  registry.add(user.id, deviceId, ws);
  websocketConnections.set(registry.size());
  logger.info({ userId: user.id, deviceId, connectionId: ws.connectionId }, 'Device connected');

  send(ws, { type: 'connected', userId: user.id, deviceId });

  const liveConnections = await touchPresence(user.id, ws.connectionId).catch(() => 0);
  if (liveConnections === 1) {
    await announcePresence(user.id, 'online');
  }

  // Catch up: everything queued for this device while it was away
  await sendInboxBatch(ws, deviceId);
}

async function onClose(ws: ClientSocket, { user, deviceId }: WsAuthResult): Promise<void> {
  registry.remove(user.id, deviceId, ws);
  websocketConnections.set(registry.size());
  logger.info({ userId: user.id, deviceId, connectionId: ws.connectionId }, 'Device disconnected');

  // Offline only when the user's last connection anywhere is gone
  const remaining = await dropPresence(user.id, ws.connectionId).catch(() => 1);
  if (remaining === 0) {
    await announcePresence(user.id, 'offline');
  }
}

async function announcePresence(userId: string, status: 'online' | 'offline'): Promise<void> {
  const peerIds = await getConversationPeerIds(userId);
  if (peerIds.length > 0) {
    await publishPresence({ userId, status, peerIds });
  }
}

/** Sends the oldest undelivered inbox rows; the client acks them, then asks again if hasMore. */
async function sendInboxBatch(ws: ClientSocket, deviceId: string): Promise<void> {
  const { messages, hasMore } = await getInboxBatch(deviceId);
  send(ws, { type: 'sync_batch', messages, hasMore });
}

async function handleFrame(ws: ClientSocket, user: User, deviceId: string, data: RawData): Promise<void> {
  let frame: ClientFrame;
  try {
    frame = JSON.parse(data.toString()) as ClientFrame;
  } catch {
    send(ws, { type: 'error', code: 'invalid', error: 'Invalid message format' });
    return;
  }

  try {
    switch (frame.type) {
      case 'send_message':
        await handleSendMessage(ws, user, deviceId, frame);
        break;
      case 'ack':
        await handleAck(user, deviceId, frame);
        break;
      case 'sync':
        await sendInboxBatch(ws, deviceId);
        break;
      case 'typing':
        await handleTyping(user, frame);
        break;
      case 'read':
        await handleRead(ws, user, deviceId, frame);
        break;
      case 'reaction':
        await handleReaction(user, frame);
        break;
      default:
        send(ws, { type: 'error', code: 'invalid', error: `Unknown message type: ${String(frame.type)}` });
    }
  } catch (error) {
    logger.error({ error, type: frame.type, userId: user.id }, 'WebSocket handler failed');
    send(ws, {
      type: 'error',
      code: 'server_error',
      error: 'Request failed',
      clientMessageId: typeof frame.clientMessageId === 'string' ? frame.clientMessageId : undefined,
    });
  }
}

async function handleSendMessage(ws: ClientSocket, user: User, deviceId: string, frame: ClientFrame): Promise<void> {
  const { conversationId, content, contentType, replyToId, clientMessageId } = frame;
  const fail = (code: string, error: string, extra: object = {}) =>
    send(ws, { type: 'error', code, error, clientMessageId, ...extra });

  if (!isUuid(conversationId)) return fail('invalid', 'conversationId is required');
  if (typeof content !== 'string' || content.trim().length === 0 || content.length > MAX_CONTENT_LENGTH) {
    return fail('invalid', `content must be 1-${MAX_CONTENT_LENGTH} characters`);
  }
  if (clientMessageId !== undefined && (typeof clientMessageId !== 'string' || clientMessageId.length === 0 || clientMessageId.length > 64)) {
    return fail('invalid', 'clientMessageId must be a string of at most 64 characters');
  }
  if (contentType !== undefined && (typeof contentType !== 'string' || !CLIENT_CONTENT_TYPES.has(contentType))) {
    return fail('invalid', 'unsupported contentType');
  }
  if (replyToId !== undefined && replyToId !== null && !isUuid(replyToId)) {
    return fail('invalid', 'replyToId must be a message ID');
  }

  // Same per-user budget as the REST send route (one Redis key for both)
  const verdict = await rateLimiter.checkLimit(
    messageRateKey(user.id),
    MESSAGE_RATE_LIMIT.limit,
    MESSAGE_RATE_LIMIT.windowSeconds
  );
  if (!verdict.allowed) {
    rateLimitExceeded.inc({ endpoint: 'messages_ws' });
    return fail('rate_limited', 'Rate limit exceeded', { retryAfter: verdict.retryAfter });
  }

  let result;
  try {
    result = await sendMessage({
      conversationId,
      senderId: user.id,
      senderDeviceId: deviceId,
      content,
      contentType: contentType as string | undefined,
      replyToId: (replyToId as string | null | undefined) ?? null,
      clientMessageId: (clientMessageId as string | undefined) ?? null,
    });
  } catch (error) {
    if (error instanceof NotParticipantError) return fail('forbidden', error.message);
    if (error instanceof IdempotencyConflictError) return fail('idempotency_conflict', error.message);
    throw error;
  }

  // The ack carries the server's seq; a duplicate gets the original message
  send(ws, {
    type: 'message_sent',
    clientMessageId,
    message: result.message,
    isDuplicate: result.isDuplicate,
  });

  // A duplicate was already published when it was first accepted, and its
  // inbox rows exist either way, so only new messages are pushed.
  if (!result.isDuplicate) {
    await publishNewMessage({
      message: result.message,
      participantIds: result.participantIds,
      senderConnectionId: ws.connectionId,
    });
  }
}

async function handleAck(user: User, deviceId: string, frame: ClientFrame): Promise<void> {
  const ids = Array.isArray(frame.messageIds)
    ? (frame.messageIds as unknown[]).filter(isUuid).slice(0, MAX_ACK_IDS)
    : [];
  if (ids.length === 0) return;

  const acked = await acknowledgeDelivery(deviceId, ids);
  await publishDeliveryReceipts(user.id, deviceId, acked);
}

async function handleTyping(user: User, frame: ClientFrame): Promise<void> {
  const { conversationId, isTyping } = frame;
  if (!isUuid(conversationId) || typeof isTyping !== 'boolean') return;
  if (!(await isParticipant(conversationId, user.id))) return;

  await setTyping(conversationId, user.id, isTyping);
  const participantIds = await getParticipantIds(conversationId);
  await publishTyping({
    conversationId,
    userId: user.id,
    username: user.username,
    displayName: user.display_name,
    isTyping,
    participantIds,
  });
}

async function handleRead(ws: ClientSocket, user: User, deviceId: string, frame: ClientFrame): Promise<void> {
  const { conversationId, messageId } = frame;
  if (!isUuid(conversationId) || !isUuid(messageId)) return;
  if (!(await isParticipant(conversationId, user.id))) return;

  const result = await markAsRead(conversationId, user.id, deviceId, messageId);
  if (!result || !result.advanced) return;

  const participantIds = await getParticipantIds(conversationId);
  await publishReadReceipt({
    conversationId,
    userId: user.id,
    deviceId,
    seq: result.seq,
    messageId,
    participantIds,
    senderConnectionId: ws.connectionId,
  });
}

async function handleReaction(user: User, frame: ClientFrame): Promise<void> {
  const { messageId, reaction, remove } = frame;
  if (!isUuid(messageId) || typeof reaction !== 'string' || reaction.length === 0 || reaction.length > 50) return;

  const message = await getMessage(messageId);
  if (!message) return;
  if (!(await isParticipant(message.conversation_id, user.id))) return;

  if (remove) {
    await removeReaction(messageId, user.id, reaction);
  } else {
    await addReaction(messageId, user.id, reaction);
  }

  const participantIds = await getParticipantIds(message.conversation_id);
  await publishReaction({
    conversationId: message.conversation_id,
    messageId,
    userId: user.id,
    reaction,
    remove: Boolean(remove),
    participantIds,
  });
}

/** Writes one frame to every local socket of the given users, optionally skipping one connection. */
function deliverToUsers(userIds: unknown, payload: object, exceptConnectionId?: string | null): void {
  if (!Array.isArray(userIds) || userIds.length === 0) return;
  const frame = JSON.stringify(payload);
  for (const ws of registry.socketsForUsers(userIds as string[])) {
    if (ws.connectionId === exceptConnectionId) continue;
    if (ws.readyState === WebSocket.OPEN) ws.send(frame);
  }
}

function handlePubSubMessage(channel: string, data: unknown): void {
  switch (channel) {
    case 'messages': {
      const event = data as NewMessageEvent;
      deliverToUsers(event.participantIds, { type: 'new_message', message: event.message }, event.senderConnectionId);
      break;
    }
    case 'typing': {
      const event = data as TypingEvent;
      deliverToUsers(
        event.participantIds?.filter((id) => id !== event.userId),
        {
          type: 'typing',
          conversationId: event.conversationId,
          userId: event.userId,
          username: event.username,
          displayName: event.displayName,
          isTyping: event.isTyping,
        }
      );
      break;
    }
    case 'read_receipts': {
      const event = data as ReadReceiptEvent;
      deliverToUsers(
        event.participantIds,
        {
          type: 'read_receipt',
          conversationId: event.conversationId,
          userId: event.userId,
          deviceId: event.deviceId,
          seq: event.seq,
          messageId: event.messageId,
        },
        event.senderConnectionId
      );
      break;
    }
    case 'delivery_receipts': {
      const event = data as DeliveryReceiptEvent;
      deliverToUsers(event.targetUserIds, {
        type: 'delivery_receipt',
        conversationId: event.conversationId,
        messageIds: event.messageIds,
        seq: event.seq,
        userId: event.userId,
        deviceId: event.deviceId,
      });
      break;
    }
    case 'reactions': {
      const event = data as ReactionEvent;
      deliverToUsers(event.participantIds, {
        type: 'reaction_update',
        conversationId: event.conversationId,
        messageId: event.messageId,
        userId: event.userId,
        reaction: event.reaction,
        remove: event.remove,
      });
      break;
    }
    case 'presence': {
      const event = data as PresenceEvent;
      deliverToUsers(event.peerIds, { type: 'presence', userId: event.userId, status: event.status });
      break;
    }
    case 'control': {
      const event = data as ControlEvent;
      if (event.type === 'device_revoked') {
        for (const ws of registry.socketsForDevice(event.userId, event.deviceId)) {
          ws.close(4003, 'Device revoked');
        }
      }
      break;
    }
  }
}

/** Closes every socket on this instance so clients reconnect elsewhere (graceful shutdown). */
export function closeAllConnections(wss: WebSocketServer): void {
  if (heartbeatInterval) clearInterval(heartbeatInterval);
  wss.clients.forEach((client) => client.close(1001, 'Server shutting down'));
}
