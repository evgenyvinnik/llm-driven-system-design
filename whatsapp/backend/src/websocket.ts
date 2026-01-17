import { WebSocketServer, WebSocket } from 'ws';
import { Server } from 'http';
import { parse as parseCookie } from 'cookie';
import { v4 as uuidv4 } from 'uuid';
import { config } from './config.js';
import { redis, redisSub, redisPub, KEYS } from './redis.js';
import { setUserPresence, getUserServer } from './services/userService.js';
import {
  isUserInConversation,
  getConversationParticipants,
  getConversationById,
} from './services/conversationService.js';
import {
  createMessage,
  updateMessageStatus,
  getPendingMessagesForUser,
  markConversationAsRead,
} from './services/messageService.js';
import { WSMessage, WSChatMessage, WSTypingMessage, WSReadReceiptMessage } from './types/index.js';

// Shared modules for observability and resilience
import { createServiceLogger, LogEvents, logEvent } from './shared/logger.js';
import {
  websocketConnections,
  websocketEvents,
  recordMessage,
  recordDeliveryDuration,
} from './shared/metrics.js';
import { checkWebSocketRateLimit } from './shared/rateLimiter.js';
import { withRedisCircuit } from './shared/circuitBreaker.js';
import { retryMessageDelivery } from './shared/retry.js';
import {
  startDeliveryTracking,
  recordDelivery,
  idempotentStatusUpdate,
} from './shared/deliveryTracker.js';

const wsLogger = createServiceLogger('websocket');

/**
 * Extended WebSocket interface with user-specific properties.
 * Tracks the authenticated user, connection health, and timing for metrics.
 */
interface AuthenticatedSocket extends WebSocket {
  userId: string;
  isAlive: boolean;
  connectedAt: number;
}

/**
 * Map of userId to their active WebSocket connection on this server.
 * Used for local message delivery before falling back to Redis pub/sub.
 */
const connections = new Map<string, AuthenticatedSocket>();

/**
 * Sets up the WebSocket server for real-time messaging.
 * Handles authentication, message routing, typing indicators, and presence.
 * Supports horizontal scaling via Redis pub/sub for cross-server communication.
 *
 * Now includes:
 * - Prometheus metrics for connections and messages
 * - Rate limiting to prevent spam
 * - Circuit breakers for Redis operations
 * - Retry logic for reliable delivery
 * - Idempotent status updates
 *
 * @param server - HTTP server to attach WebSocket to
 * @param sessionMiddleware - Express session middleware for authentication
 * @returns The configured WebSocketServer instance
 */
export function setupWebSocket(server: Server, sessionMiddleware: any): WebSocketServer {
  const wss = new WebSocketServer({ server, path: '/ws' });

  // Subscribe to this server's Redis channel for cross-server messaging
  // Wrapped in circuit breaker for resilience
  withRedisCircuit(async () => {
    await redisSub.subscribe(KEYS.serverChannel(config.serverId));
    wsLogger.info({ channel: KEYS.serverChannel(config.serverId) }, 'Subscribed to Redis channel');
  }).catch((error) => {
    wsLogger.error({ error }, 'Failed to subscribe to Redis channel');
  });

  redisSub.on('message', async (channel, message) => {
    if (channel === KEYS.serverChannel(config.serverId)) {
      try {
        const data = JSON.parse(message);
        await handleRedisMessage(data);
      } catch (error) {
        wsLogger.error({ error, channel }, 'Error handling Redis message');
      }
    }
  });

  wss.on('connection', async (ws: WebSocket, req) => {
    const socket = ws as AuthenticatedSocket;
    socket.connectedAt = Date.now();

    try {
      // Parse session from cookie
      const cookies = parseCookie(req.headers.cookie || '');
      const sessionId = cookies['connect.sid'];

      if (!sessionId) {
        websocketEvents.inc({ event: 'auth_failed' });
        socket.close(4001, 'No session');
        return;
      }

      // Get user ID from session store (Redis)
      const sessionKey = `sess:${sessionId.replace('s:', '').split('.')[0]}`;
      const sessionData = await redis.get(sessionKey);

      if (!sessionData) {
        websocketEvents.inc({ event: 'auth_failed' });
        socket.close(4001, 'Invalid session');
        return;
      }

      const session = JSON.parse(sessionData);
      const userId = session.userId;

      if (!userId) {
        websocketEvents.inc({ event: 'auth_failed' });
        socket.close(4001, 'Not authenticated');
        return;
      }

      socket.userId = userId;
      socket.isAlive = true;

      // Store connection
      connections.set(userId, socket);

      // Update metrics
      websocketConnections.inc();
      websocketEvents.inc({ event: 'connect' });

      // Set presence to online
      await setUserPresence(userId, 'online', config.serverId);

      logEvent(LogEvents.WS_CONNECTED, {
        user_id: userId,
        server_id: config.serverId,
      });

      wsLogger.info({ userId, serverId: config.serverId }, 'User connected');

      // Send pending messages with retry logic
      try {
        const pendingMessages = await getPendingMessagesForUser(userId);
        for (const msg of pendingMessages) {
          sendToSocket(socket, {
            type: 'message',
            payload: msg,
          });

          // Use idempotent status update
          const wasUpdated = await idempotentStatusUpdate(msg.id, userId, 'delivered');

          if (wasUpdated) {
            // Record delivery metrics for pending messages
            await recordDelivery(msg.id, userId, 'pending');

            // Notify sender of delivery
            await notifyDeliveryReceipt(msg.sender_id, msg.id, userId, 'delivered');
          }
        }

        if (pendingMessages.length > 0) {
          wsLogger.info(
            { userId, count: pendingMessages.length },
            'Delivered pending messages'
          );
        }
      } catch (error) {
        wsLogger.error({ error, userId }, 'Error delivering pending messages');
      }

      // Broadcast presence to relevant users
      await broadcastPresence(userId, 'online');

      // Handle pong for heartbeat
      socket.on('pong', () => {
        socket.isAlive = true;
      });

      // Handle messages
      socket.on('message', async (data) => {
        try {
          const message: WSMessage = JSON.parse(data.toString());
          await handleWebSocketMessage(socket, message);
        } catch (error) {
          wsLogger.error({ error, userId }, 'Error handling WebSocket message');
          sendToSocket(socket, {
            type: 'error',
            payload: { message: 'Invalid message format' },
          });
        }
      });

      // Handle disconnect
      socket.on('close', async () => {
        connections.delete(userId);

        // Update metrics
        websocketConnections.dec();
        websocketEvents.inc({ event: 'disconnect' });

        // Calculate connection duration for logging
        const connectionDuration = (Date.now() - socket.connectedAt) / 1000;

        await setUserPresence(userId, 'offline');
        await broadcastPresence(userId, 'offline');

        logEvent(LogEvents.WS_DISCONNECTED, {
          user_id: userId,
          server_id: config.serverId,
          duration_seconds: connectionDuration,
        });

        wsLogger.info(
          { userId, duration: connectionDuration },
          'User disconnected'
        );
      });

      socket.on('error', (error) => {
        websocketEvents.inc({ event: 'error' });
        logEvent(LogEvents.WS_ERROR, {
          user_id: userId,
          error: error.message,
        });
        wsLogger.error({ error, userId }, 'WebSocket error');
      });
    } catch (error) {
      websocketEvents.inc({ event: 'error' });
      wsLogger.error({ error }, 'WebSocket connection error');
      socket.close(4000, 'Internal error');
    }
  });

  // Heartbeat to detect broken connections
  const heartbeatInterval = setInterval(() => {
    wss.clients.forEach((ws) => {
      const socket = ws as AuthenticatedSocket;
      if (!socket.isAlive) {
        connections.delete(socket.userId);
        websocketConnections.dec();
        websocketEvents.inc({ event: 'timeout' });
        return socket.terminate();
      }
      socket.isAlive = false;
      socket.ping();
    });
  }, 30000);

  wss.on('close', () => {
    clearInterval(heartbeatInterval);
    redisSub.unsubscribe(KEYS.serverChannel(config.serverId));
  });

  return wss;
}

/**
 * Routes incoming WebSocket messages to appropriate handlers.
 * Applies rate limiting to prevent spam.
 *
 * @param socket - The authenticated WebSocket connection
 * @param message - The parsed WebSocket message
 */
async function handleWebSocketMessage(socket: AuthenticatedSocket, message: WSMessage) {
  const userId = socket.userId;

  switch (message.type) {
    case 'message': {
      // Apply rate limiting
      const rateCheck = await checkWebSocketRateLimit(userId, 'message');
      if (!rateCheck.allowed) {
        sendToSocket(socket, {
          type: 'error',
          payload: {
            code: 'RATE_LIMITED',
            message: `Too many messages. Please wait ${Math.ceil(rateCheck.resetIn / 1000)} seconds.`,
            remaining: rateCheck.remaining,
          },
        });
        return;
      }
      await handleChatMessage(socket, message as WSChatMessage);
      break;
    }

    case 'typing':
    case 'stop_typing': {
      // Apply rate limiting for typing events
      const rateCheck = await checkWebSocketRateLimit(userId, 'typing');
      if (!rateCheck.allowed) {
        return; // Silently drop typing events when rate limited
      }
      await handleTyping(socket, message as WSTypingMessage);
      break;
    }

    case 'read_receipt':
      await handleReadReceipt(socket, message as WSReadReceiptMessage);
      break;

    default:
      sendToSocket(socket, {
        type: 'error',
        payload: { message: `Unknown message type: ${message.type}` },
      });
  }
}

/**
 * Handles sending a chat message.
 * Persists to database, sends acknowledgment, and routes to all participants.
 * Uses local delivery for same-server recipients, Redis pub/sub for others.
 *
 * Now includes:
 * - Delivery tracking for metrics
 * - Circuit breaker for Redis operations
 * - Retry logic for reliable delivery
 *
 * @param socket - The sender's WebSocket connection
 * @param message - The message payload with conversation and content
 */
async function handleChatMessage(socket: AuthenticatedSocket, message: WSChatMessage) {
  const userId = socket.userId;
  const { conversationId, content, contentType, mediaUrl } = message.payload;
  const clientMessageId = message.clientMessageId || uuidv4();
  const sendStartTime = Date.now();

  try {
    // Validate user is in conversation
    const isParticipant = await isUserInConversation(userId, conversationId);
    if (!isParticipant) {
      sendToSocket(socket, {
        type: 'error',
        payload: { message: 'Not a participant in this conversation', clientMessageId },
      });
      recordMessage('failed', contentType || 'text');
      return;
    }

    // Create message in database with retry logic
    const savedMessage = await retryMessageDelivery(
      () =>
        createMessage(
          conversationId,
          userId,
          content,
          contentType || 'text',
          mediaUrl
        ),
      clientMessageId,
      userId
    );

    // Start delivery tracking for metrics
    await startDeliveryTracking(savedMessage.id, userId);

    // Send acknowledgment to sender
    sendToSocket(socket, {
      type: 'message_ack',
      payload: {
        clientMessageId,
        messageId: savedMessage.id,
        status: 'sent',
        createdAt: savedMessage.created_at,
      },
    });

    logEvent(LogEvents.MESSAGE_SENT, {
      message_id: savedMessage.id,
      conversation_id: conversationId,
      sender_id: userId,
      content_type: contentType || 'text',
    });

    // Get conversation info
    const conversation = await getConversationById(conversationId);
    const participants = await getConversationParticipants(conversationId);

    // Send to all other participants
    for (const participant of participants) {
      if (participant.user_id === userId) continue;

      const recipientServer = await getUserServer(participant.user_id);

      const messagePayload = {
        ...savedMessage,
        sender: participant.user,
        conversation: {
          id: conversationId,
          name: conversation?.name,
          is_group: conversation?.is_group,
        },
      };

      if (recipientServer === config.serverId) {
        // Local delivery
        const recipientSocket = connections.get(participant.user_id);
        if (recipientSocket) {
          sendToSocket(recipientSocket, {
            type: 'message',
            payload: messagePayload,
          });

          // Use idempotent status update
          const wasUpdated = await idempotentStatusUpdate(
            savedMessage.id,
            participant.user_id,
            'delivered'
          );

          if (wasUpdated) {
            // Calculate delivery duration
            const deliveryDuration = (Date.now() - sendStartTime) / 1000;
            recordDeliveryDuration(deliveryDuration, 'local');

            await recordDelivery(savedMessage.id, participant.user_id, 'local');

            // Notify sender of delivery
            sendToSocket(socket, {
              type: 'delivery_receipt',
              payload: {
                messageId: savedMessage.id,
                recipientId: participant.user_id,
                status: 'delivered',
                timestamp: new Date(),
              },
            });
          }
        }
      } else if (recipientServer) {
        // Route through Redis pub/sub to other server with circuit breaker
        await withRedisCircuit(
          async () => {
            await redisPub.publish(
              KEYS.serverChannel(recipientServer),
              JSON.stringify({
                type: 'deliver_message',
                recipientId: participant.user_id,
                senderId: userId,
                senderServer: config.serverId,
                messageId: savedMessage.id,
                sendStartTime,
                payload: messagePayload,
              })
            );
          },
          undefined // No fallback - message stays in DB for later delivery
        );
      }
      // If recipientServer is null, user is offline - message is stored for later
    }
  } catch (error) {
    wsLogger.error({ error, conversationId, userId }, 'Error handling chat message');
    recordMessage('failed', contentType || 'text');
    sendToSocket(socket, {
      type: 'error',
      payload: { message: 'Failed to send message', clientMessageId },
    });
  }
}

/**
 * Handles typing indicator events.
 * Stores typing state in Redis with auto-expiry and broadcasts to participants.
 *
 * @param socket - The typing user's WebSocket connection
 * @param message - The typing event payload
 */
async function handleTyping(socket: AuthenticatedSocket, message: WSTypingMessage) {
  const userId = socket.userId;
  const { conversationId } = message.payload;
  const isTyping = message.type === 'typing';

  try {
    // Store typing state briefly with circuit breaker
    await withRedisCircuit(async () => {
      if (isTyping) {
        await redis.setex(KEYS.typing(conversationId, userId), 5, '1');
      } else {
        await redis.del(KEYS.typing(conversationId, userId));
      }
    });

    // Get participants and notify them
    const participants = await getConversationParticipants(conversationId);

    for (const participant of participants) {
      if (participant.user_id === userId) continue;

      const recipientServer = await getUserServer(participant.user_id);

      const typingPayload = {
        type: message.type,
        payload: {
          conversationId,
          userId,
        },
      };

      if (recipientServer === config.serverId) {
        const recipientSocket = connections.get(participant.user_id);
        if (recipientSocket) {
          sendToSocket(recipientSocket, typingPayload);
        }
      } else if (recipientServer) {
        await withRedisCircuit(async () => {
          await redisPub.publish(
            KEYS.serverChannel(recipientServer),
            JSON.stringify({
              type: 'forward_typing',
              recipientId: participant.user_id,
              payload: typingPayload,
            })
          );
        });
      }
    }
  } catch (error) {
    wsLogger.error({ error, conversationId, userId }, 'Error handling typing');
  }
}

/**
 * Handles read receipt events.
 * Marks messages as read in database and notifies senders.
 * Uses idempotent updates to prevent duplicate processing.
 *
 * @param socket - The reader's WebSocket connection
 * @param message - The read receipt payload with conversation and message IDs
 */
async function handleReadReceipt(socket: AuthenticatedSocket, message: WSReadReceiptMessage) {
  const userId = socket.userId;
  const { conversationId, messageIds } = message.payload;

  try {
    // Mark messages as read with idempotent updates
    const markedIds = await markConversationAsRead(conversationId, userId);

    if (markedIds.length === 0) return;

    // Record read metrics
    for (const id of markedIds) {
      recordMessage('read', 'text');
    }

    // Get participants to notify senders
    const participants = await getConversationParticipants(conversationId);

    // Notify the senders of the read messages
    for (const participant of participants) {
      if (participant.user_id === userId) continue;

      await notifyDeliveryReceipt(participant.user_id, markedIds[0], userId, 'read', markedIds);
    }
  } catch (error) {
    wsLogger.error({ error, conversationId, userId }, 'Error handling read receipt');
  }
}

/**
 * Sends a delivery or read receipt to a message sender.
 * Routes through local connection or Redis pub/sub based on recipient's server.
 *
 * @param recipientUserId - The message sender to notify
 * @param messageId - The message that was delivered/read
 * @param readerId - The user who received/read the message
 * @param status - Either 'delivered' or 'read'
 * @param allMessageIds - Optional array of all message IDs being marked
 */
async function notifyDeliveryReceipt(
  recipientUserId: string,
  messageId: string,
  readerId: string,
  status: 'delivered' | 'read',
  allMessageIds?: string[]
) {
  const recipientServer = await getUserServer(recipientUserId);

  const receiptPayload = {
    type: status === 'read' ? 'read_receipt' : 'delivery_receipt',
    payload: {
      messageId,
      messageIds: allMessageIds || [messageId],
      recipientId: readerId,
      status,
      timestamp: new Date(),
    },
  };

  if (recipientServer === config.serverId) {
    const recipientSocket = connections.get(recipientUserId);
    if (recipientSocket) {
      sendToSocket(recipientSocket, receiptPayload);
    }
  } else if (recipientServer) {
    await withRedisCircuit(async () => {
      await redisPub.publish(
        KEYS.serverChannel(recipientServer),
        JSON.stringify({
          type: 'forward_receipt',
          recipientId: recipientUserId,
          payload: receiptPayload,
        })
      );
    });
  }
}

/**
 * Broadcasts a user's presence change to all connected users.
 *
 * @param userId - The user whose presence changed
 * @param status - The new presence status ('online' or 'offline')
 */
async function broadcastPresence(userId: string, status: 'online' | 'offline') {
  const presencePayload = {
    type: 'presence',
    payload: {
      userId,
      status,
      timestamp: Date.now(),
    },
  };

  // Broadcast to all connected users on this server
  for (const [connectedUserId, socket] of connections) {
    if (connectedUserId !== userId) {
      sendToSocket(socket, presencePayload);
    }
  }
}

/**
 * Handles messages received from Redis pub/sub.
 * Processes cross-server message delivery, typing events, and receipts.
 *
 * @param data - The parsed message from Redis
 */
async function handleRedisMessage(data: any) {
  switch (data.type) {
    case 'deliver_message': {
      const socket = connections.get(data.recipientId);
      if (socket) {
        sendToSocket(socket, {
          type: 'message',
          payload: data.payload,
        });

        // Use idempotent status update
        const wasUpdated = await idempotentStatusUpdate(
          data.messageId,
          data.recipientId,
          'delivered'
        );

        if (wasUpdated) {
          // Calculate cross-server delivery duration
          const deliveryDuration = (Date.now() - data.sendStartTime) / 1000;
          recordDeliveryDuration(deliveryDuration, 'cross_server');

          await recordDelivery(data.messageId, data.recipientId, 'cross_server');

          // Send delivery receipt back to sender's server
          await withRedisCircuit(async () => {
            await redisPub.publish(
              KEYS.serverChannel(data.senderServer),
              JSON.stringify({
                type: 'forward_receipt',
                recipientId: data.senderId,
                payload: {
                  type: 'delivery_receipt',
                  payload: {
                    messageId: data.messageId,
                    recipientId: data.recipientId,
                    status: 'delivered',
                    timestamp: new Date(),
                  },
                },
              })
            );
          });
        }
      }
      break;
    }

    case 'forward_typing':
    case 'forward_receipt': {
      const socket = connections.get(data.recipientId);
      if (socket) {
        sendToSocket(socket, data.payload);
      }
      break;
    }
  }
}

/**
 * Safely sends a message to a WebSocket connection.
 * Checks connection state before sending to avoid errors.
 *
 * @param socket - The WebSocket to send to
 * @param message - The message object to serialize and send
 */
function sendToSocket(socket: WebSocket, message: any) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

/**
 * Returns the number of active WebSocket connections on this server.
 * Used for health checks and load monitoring.
 *
 * @returns The count of connected users
 */
export function getConnectionCount(): number {
  return connections.size;
}
