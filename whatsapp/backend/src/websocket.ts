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

interface AuthenticatedSocket extends WebSocket {
  userId: string;
  isAlive: boolean;
}

// Map of userId -> WebSocket connection on this server
const connections = new Map<string, AuthenticatedSocket>();

export function setupWebSocket(server: Server, sessionMiddleware: any): WebSocketServer {
  const wss = new WebSocketServer({ server, path: '/ws' });

  // Subscribe to this server's Redis channel for cross-server messaging
  redisSub.subscribe(KEYS.serverChannel(config.serverId));

  redisSub.on('message', async (channel, message) => {
    if (channel === KEYS.serverChannel(config.serverId)) {
      try {
        const data = JSON.parse(message);
        await handleRedisMessage(data);
      } catch (error) {
        console.error('Error handling Redis message:', error);
      }
    }
  });

  wss.on('connection', async (ws: WebSocket, req) => {
    const socket = ws as AuthenticatedSocket;

    try {
      // Parse session from cookie
      const cookies = parseCookie(req.headers.cookie || '');
      const sessionId = cookies['connect.sid'];

      if (!sessionId) {
        socket.close(4001, 'No session');
        return;
      }

      // Get user ID from session store (Redis)
      const sessionKey = `sess:${sessionId.replace('s:', '').split('.')[0]}`;
      const sessionData = await redis.get(sessionKey);

      if (!sessionData) {
        socket.close(4001, 'Invalid session');
        return;
      }

      const session = JSON.parse(sessionData);
      const userId = session.userId;

      if (!userId) {
        socket.close(4001, 'Not authenticated');
        return;
      }

      socket.userId = userId;
      socket.isAlive = true;

      // Store connection
      connections.set(userId, socket);

      // Set presence to online
      await setUserPresence(userId, 'online', config.serverId);

      console.log(`User ${userId} connected on ${config.serverId}`);

      // Send pending messages
      const pendingMessages = await getPendingMessagesForUser(userId);
      for (const msg of pendingMessages) {
        sendToSocket(socket, {
          type: 'message',
          payload: msg,
        });

        // Mark as delivered
        await updateMessageStatus(msg.id, userId, 'delivered');

        // Notify sender of delivery
        await notifyDeliveryReceipt(msg.sender_id, msg.id, userId, 'delivered');
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
          console.error('Error handling WebSocket message:', error);
          sendToSocket(socket, {
            type: 'error',
            payload: { message: 'Invalid message format' },
          });
        }
      });

      // Handle disconnect
      socket.on('close', async () => {
        connections.delete(userId);
        await setUserPresence(userId, 'offline');
        await broadcastPresence(userId, 'offline');
        console.log(`User ${userId} disconnected from ${config.serverId}`);
      });

      socket.on('error', (error) => {
        console.error(`WebSocket error for user ${userId}:`, error);
      });
    } catch (error) {
      console.error('WebSocket connection error:', error);
      socket.close(4000, 'Internal error');
    }
  });

  // Heartbeat to detect broken connections
  const heartbeatInterval = setInterval(() => {
    wss.clients.forEach((ws) => {
      const socket = ws as AuthenticatedSocket;
      if (!socket.isAlive) {
        connections.delete(socket.userId);
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

async function handleWebSocketMessage(socket: AuthenticatedSocket, message: WSMessage) {
  const userId = socket.userId;

  switch (message.type) {
    case 'message':
      await handleChatMessage(socket, message as WSChatMessage);
      break;

    case 'typing':
    case 'stop_typing':
      await handleTyping(socket, message as WSTypingMessage);
      break;

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

async function handleChatMessage(socket: AuthenticatedSocket, message: WSChatMessage) {
  const userId = socket.userId;
  const { conversationId, content, contentType, mediaUrl } = message.payload;
  const clientMessageId = message.clientMessageId || uuidv4();

  try {
    // Validate user is in conversation
    const isParticipant = await isUserInConversation(userId, conversationId);
    if (!isParticipant) {
      sendToSocket(socket, {
        type: 'error',
        payload: { message: 'Not a participant in this conversation', clientMessageId },
      });
      return;
    }

    // Create message in database
    const savedMessage = await createMessage(
      conversationId,
      userId,
      content,
      contentType || 'text',
      mediaUrl
    );

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

    // Get conversation info
    const conversation = await getConversationById(conversationId);
    const participants = await getConversationParticipants(conversationId);

    // Send to all other participants
    for (const participant of participants) {
      if (participant.user_id === userId) continue;

      const recipientServer = await getUserServer(participant.user_id);

      const messagePayload = {
        ...savedMessage,
        sender: participant.user, // Will be filled with sender info
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

          // Mark as delivered
          await updateMessageStatus(savedMessage.id, participant.user_id, 'delivered');

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
      } else if (recipientServer) {
        // Route through Redis pub/sub to other server
        await redisPub.publish(
          KEYS.serverChannel(recipientServer),
          JSON.stringify({
            type: 'deliver_message',
            recipientId: participant.user_id,
            senderId: userId,
            senderServer: config.serverId,
            messageId: savedMessage.id,
            payload: messagePayload,
          })
        );
      }
      // If recipientServer is null, user is offline - message is stored for later
    }
  } catch (error) {
    console.error('Error handling chat message:', error);
    sendToSocket(socket, {
      type: 'error',
      payload: { message: 'Failed to send message', clientMessageId },
    });
  }
}

async function handleTyping(socket: AuthenticatedSocket, message: WSTypingMessage) {
  const userId = socket.userId;
  const { conversationId } = message.payload;
  const isTyping = message.type === 'typing';

  try {
    // Store typing state briefly
    if (isTyping) {
      await redis.setex(KEYS.typing(conversationId, userId), 5, '1');
    } else {
      await redis.del(KEYS.typing(conversationId, userId));
    }

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
        await redisPub.publish(
          KEYS.serverChannel(recipientServer),
          JSON.stringify({
            type: 'forward_typing',
            recipientId: participant.user_id,
            payload: typingPayload,
          })
        );
      }
    }
  } catch (error) {
    console.error('Error handling typing:', error);
  }
}

async function handleReadReceipt(socket: AuthenticatedSocket, message: WSReadReceiptMessage) {
  const userId = socket.userId;
  const { conversationId, messageIds } = message.payload;

  try {
    // Mark messages as read
    const markedIds = await markConversationAsRead(conversationId, userId);

    if (markedIds.length === 0) return;

    // Get participants to notify senders
    const participants = await getConversationParticipants(conversationId);

    // We need to notify the senders of the read messages
    // For simplicity, notify all other participants
    for (const participant of participants) {
      if (participant.user_id === userId) continue;

      await notifyDeliveryReceipt(participant.user_id, markedIds[0], userId, 'read', markedIds);
    }
  } catch (error) {
    console.error('Error handling read receipt:', error);
  }
}

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
    await redisPub.publish(
      KEYS.serverChannel(recipientServer),
      JSON.stringify({
        type: 'forward_receipt',
        recipientId: recipientUserId,
        payload: receiptPayload,
      })
    );
  }
}

async function broadcastPresence(userId: string, status: 'online' | 'offline') {
  // Get user's recent conversations and notify participants
  // For simplicity, we'll broadcast to users who have active connections
  // In production, you'd track who's "watching" this user's presence

  const presencePayload = {
    type: 'presence',
    payload: {
      userId,
      status,
      timestamp: Date.now(),
    },
  };

  // Broadcast to all connected users on this server
  // (In production, you'd be more selective)
  for (const [connectedUserId, socket] of connections) {
    if (connectedUserId !== userId) {
      sendToSocket(socket, presencePayload);
    }
  }

  // Broadcast to other servers via Redis
  // This is simplified - in production you'd track interested users
}

async function handleRedisMessage(data: any) {
  switch (data.type) {
    case 'deliver_message': {
      const socket = connections.get(data.recipientId);
      if (socket) {
        sendToSocket(socket, {
          type: 'message',
          payload: data.payload,
        });

        // Mark as delivered and notify sender's server
        await updateMessageStatus(data.messageId, data.recipientId, 'delivered');

        // Send delivery receipt back to sender's server
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

function sendToSocket(socket: WebSocket, message: any) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

export function getConnectionCount(): number {
  return connections.size;
}
