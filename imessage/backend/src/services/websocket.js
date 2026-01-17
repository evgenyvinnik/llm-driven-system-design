import { WebSocketServer } from 'ws';
import { v4 as uuid } from 'uuid';
import { authenticateWs } from '../middleware/auth.js';
import { sendMessage, markAsRead, addReaction, removeReaction, getMessage } from '../services/messages.js';
import { isParticipant, getParticipantIds } from '../services/conversations.js';
import {
  pubClient,
  subClient,
  setPresence,
  deletePresence,
  setTyping,
  getTypingUsers,
  addConnection,
  removeConnection,
  getUserConnections,
  getOfflineMessages,
  queueOfflineMessage,
} from '../redis.js';

// Store active connections: userId -> Map<deviceId, ws>
const connections = new Map();

// Server ID for distributed routing
const SERVER_ID = process.env.PORT || uuid();

export function setupWebSocket(server) {
  const wss = new WebSocketServer({ server, path: '/ws' });

  // Subscribe to Redis channels for cross-server messaging
  subClient.subscribe('messages', 'typing', 'presence', 'read_receipts', 'reactions');

  subClient.on('message', (channel, message) => {
    const data = JSON.parse(message);
    handlePubSubMessage(channel, data);
  });

  wss.on('connection', async (ws, req) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const token = url.searchParams.get('token');

    const authResult = await authenticateWs(token);
    if (!authResult) {
      ws.close(4001, 'Unauthorized');
      return;
    }

    const { user, deviceId } = authResult;

    // Store connection
    if (!connections.has(user.id)) {
      connections.set(user.id, new Map());
    }
    connections.get(user.id).set(deviceId, ws);

    // Register connection in Redis for distributed routing
    await addConnection(user.id, deviceId, SERVER_ID);
    await setPresence(user.id, deviceId, 'online');

    console.log(`User ${user.username} connected on device ${deviceId}`);

    // Send connection confirmation
    ws.send(JSON.stringify({
      type: 'connected',
      userId: user.id,
      deviceId,
    }));

    // Deliver offline messages
    const offlineMessages = await getOfflineMessages(user.id, deviceId);
    if (offlineMessages.length > 0) {
      ws.send(JSON.stringify({
        type: 'offline_messages',
        messages: offlineMessages,
      }));
    }

    // Setup heartbeat
    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
      setPresence(user.id, deviceId, 'online');
    });

    // Handle messages
    ws.on('message', async (data) => {
      try {
        const message = JSON.parse(data.toString());
        await handleClientMessage(ws, user, deviceId, message);
      } catch (error) {
        console.error('WebSocket message error:', error);
        ws.send(JSON.stringify({
          type: 'error',
          error: 'Invalid message format',
        }));
      }
    });

    // Handle disconnect
    ws.on('close', async () => {
      console.log(`User ${user.username} disconnected from device ${deviceId}`);

      const userConnections = connections.get(user.id);
      if (userConnections) {
        userConnections.delete(deviceId);
        if (userConnections.size === 0) {
          connections.delete(user.id);
        }
      }

      await removeConnection(user.id, deviceId);
      await deletePresence(user.id);

      // Broadcast offline status
      await pubClient.publish('presence', JSON.stringify({
        userId: user.id,
        status: 'offline',
      }));
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
  }, parseInt(process.env.WS_HEARTBEAT_INTERVAL || '30000'));

  wss.on('close', () => {
    clearInterval(heartbeatInterval);
  });

  return wss;
}

async function handleClientMessage(ws, user, deviceId, message) {
  const { type, ...payload } = message;

  switch (type) {
    case 'send_message':
      await handleSendMessage(ws, user, deviceId, payload);
      break;

    case 'typing':
      await handleTyping(user, payload);
      break;

    case 'read':
      await handleRead(user, deviceId, payload);
      break;

    case 'reaction':
      await handleReaction(user, payload);
      break;

    case 'sync':
      await handleSync(ws, user, deviceId, payload);
      break;

    default:
      ws.send(JSON.stringify({
        type: 'error',
        error: `Unknown message type: ${type}`,
      }));
  }
}

async function handleSendMessage(ws, user, deviceId, payload) {
  const { conversationId, content, contentType, replyToId, clientMessageId } = payload;

  // Verify user is participant
  if (!(await isParticipant(conversationId, user.id))) {
    ws.send(JSON.stringify({
      type: 'error',
      error: 'Not a participant of this conversation',
      clientMessageId,
    }));
    return;
  }

  // Save message
  const message = await sendMessage(conversationId, user.id, content, {
    contentType,
    replyToId,
  });

  // Acknowledge to sender
  ws.send(JSON.stringify({
    type: 'message_sent',
    clientMessageId,
    message,
  }));

  // Get all participants
  const participantIds = await getParticipantIds(conversationId);

  // Broadcast to all participants
  await pubClient.publish('messages', JSON.stringify({
    type: 'new_message',
    message,
    participantIds,
    senderId: user.id,
    senderDeviceId: deviceId,
  }));
}

async function handleTyping(user, payload) {
  const { conversationId, isTyping } = payload;

  // Verify user is participant
  if (!(await isParticipant(conversationId, user.id))) {
    return;
  }

  // Update Redis
  await setTyping(conversationId, user.id, isTyping);

  // Get all participants
  const participantIds = await getParticipantIds(conversationId);

  // Broadcast typing status
  await pubClient.publish('typing', JSON.stringify({
    conversationId,
    userId: user.id,
    username: user.username,
    displayName: user.display_name,
    isTyping,
    participantIds,
  }));
}

async function handleRead(user, deviceId, payload) {
  const { conversationId, messageId } = payload;

  // Verify user is participant
  if (!(await isParticipant(conversationId, user.id))) {
    return;
  }

  // Update read receipt
  await markAsRead(conversationId, user.id, deviceId, messageId);

  // Get all participants
  const participantIds = await getParticipantIds(conversationId);

  // Broadcast read receipt
  await pubClient.publish('read_receipts', JSON.stringify({
    conversationId,
    userId: user.id,
    messageId,
    participantIds,
  }));
}

async function handleReaction(user, payload) {
  const { messageId, reaction, remove } = payload;

  const message = await getMessage(messageId);
  if (!message) return;

  // Verify user is participant
  if (!(await isParticipant(message.conversation_id, user.id))) {
    return;
  }

  if (remove) {
    await removeReaction(messageId, user.id, reaction);
  } else {
    await addReaction(messageId, user.id, reaction);
  }

  // Get all participants
  const participantIds = await getParticipantIds(message.conversation_id);

  // Broadcast reaction update
  await pubClient.publish('reactions', JSON.stringify({
    conversationId: message.conversation_id,
    messageId,
    userId: user.id,
    reaction,
    remove,
    participantIds,
  }));
}

async function handleSync(ws, user, deviceId, payload) {
  // Client requests sync after reconnection
  // This is handled by the offline message queue
  ws.send(JSON.stringify({
    type: 'sync_complete',
  }));
}

function handlePubSubMessage(channel, data) {
  switch (channel) {
    case 'messages':
      deliverMessage(data);
      break;

    case 'typing':
      deliverTyping(data);
      break;

    case 'read_receipts':
      deliverReadReceipt(data);
      break;

    case 'reactions':
      deliverReaction(data);
      break;

    case 'presence':
      deliverPresence(data);
      break;
  }
}

async function deliverMessage(data) {
  const { message, participantIds, senderId, senderDeviceId } = data;

  for (const participantId of participantIds) {
    const userConnections = connections.get(participantId);

    if (userConnections) {
      for (const [deviceId, ws] of userConnections) {
        // Skip the sender's device that sent the message
        if (participantId === senderId && deviceId === senderDeviceId) {
          continue;
        }

        ws.send(JSON.stringify({
          type: 'new_message',
          message,
        }));
      }
    } else if (participantId !== senderId) {
      // User not connected on this server, check if connected elsewhere
      const remoteConnections = await getUserConnections(participantId);

      if (Object.keys(remoteConnections).length === 0) {
        // User is offline, queue message
        const devices = await getUserDevicesFromDb(participantId);
        for (const device of devices) {
          await queueOfflineMessage(participantId, device.id, {
            type: 'new_message',
            message,
          });
        }
      }
      // If connected to another server, they'll receive via their own pub/sub
    }
  }
}

async function deliverTyping(data) {
  const { conversationId, userId, username, displayName, isTyping, participantIds } = data;

  for (const participantId of participantIds) {
    if (participantId === userId) continue;

    const userConnections = connections.get(participantId);
    if (userConnections) {
      for (const [, ws] of userConnections) {
        ws.send(JSON.stringify({
          type: 'typing',
          conversationId,
          userId,
          username,
          displayName,
          isTyping,
        }));
      }
    }
  }
}

async function deliverReadReceipt(data) {
  const { conversationId, userId, messageId, participantIds } = data;

  for (const participantId of participantIds) {
    if (participantId === userId) continue;

    const userConnections = connections.get(participantId);
    if (userConnections) {
      for (const [, ws] of userConnections) {
        ws.send(JSON.stringify({
          type: 'read_receipt',
          conversationId,
          userId,
          messageId,
        }));
      }
    }
  }
}

async function deliverReaction(data) {
  const { conversationId, messageId, userId, reaction, remove, participantIds } = data;

  for (const participantId of participantIds) {
    const userConnections = connections.get(participantId);
    if (userConnections) {
      for (const [, ws] of userConnections) {
        ws.send(JSON.stringify({
          type: 'reaction_update',
          conversationId,
          messageId,
          userId,
          reaction,
          remove,
        }));
      }
    }
  }
}

function deliverPresence(data) {
  const { userId, status } = data;

  // Broadcast to all connected users who have conversations with this user
  for (const [, userConnections] of connections) {
    for (const [, ws] of userConnections) {
      ws.send(JSON.stringify({
        type: 'presence',
        userId,
        status,
      }));
    }
  }
}

// Helper to get user devices from database
import { query } from '../db.js';

async function getUserDevicesFromDb(userId) {
  const result = await query(
    'SELECT id FROM devices WHERE user_id = $1 AND is_active = true',
    [userId]
  );
  return result.rows;
}
