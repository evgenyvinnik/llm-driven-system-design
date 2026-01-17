const { v4: uuidv4 } = require('uuid');
const { query } = require('./database');
const { publishMessage, subscribe, unsubscribe, checkRateLimit, getRedisClient } = require('./redis');
const { logger, logChatEvent } = require('../utils/logger');
const { incChatMessage, incChatRateLimited, incWsConnection, decWsConnection } = require('../utils/metrics');
const { checkChatMessageDedup, generateChatMessageId } = require('../utils/idempotency');
const { createCircuitBreaker } = require('../utils/circuitBreaker');

// Map of channelId -> Set of WebSocket clients
const channelClients = new Map();

// Map of WebSocket -> client info
const clientInfo = new Map();

// Circuit breaker for Redis publish operations
let redisChatBreaker = null;

// Local broadcast fallback when Redis is unavailable
function localBroadcast(channelId, message) {
  const clients = channelClients.get(channelId);
  if (!clients) return;

  const data = JSON.stringify(message);
  clients.forEach(client => {
    if (client.readyState === 1) {
      client.send(data);
    }
  });
}

function setupChatWebSocket(wss, redisClient) {
  // Initialize circuit breaker for Redis chat publishing
  redisChatBreaker = createCircuitBreaker(
    'redis-chat-publish',
    async (channel, message) => {
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
  redisChatBreaker.fallback((channel, message) => {
    logger.warn({ channel }, 'Redis unavailable, using local broadcast only');
    const channelId = channel.replace('chat:', '');
    localBroadcast(channelId, message);
    return { fallback: true };
  });

  wss.on('connection', (ws, req) => {
    const clientId = uuidv4();
    logger.debug({ client_id: clientId }, 'Chat client connected');
    incWsConnection();

    clientInfo.set(ws, { clientId, channels: new Set(), userId: null, username: null });

    ws.on('message', async (data) => {
      try {
        const message = JSON.parse(data.toString());
        await handleChatMessage(ws, message);
      } catch (error) {
        logger.error({ error: error.message, client_id: clientId }, 'Error handling chat message');
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

    ws.on('error', (error) => {
      logger.error({ error: error.message }, 'WebSocket error');
    });
  });

  // Subscribe to Redis pub/sub for cross-instance chat
  setupRedisSubscriptions(redisClient);
}

async function handleChatMessage(ws, message) {
  const info = clientInfo.get(ws);
  if (!info) return;

  switch (message.type) {
    case 'auth':
      await handleAuth(ws, info, message);
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

async function handleAuth(ws, info, message) {
  const { userId, username } = message;

  if (userId && username) {
    info.userId = userId;
    info.username = username;

    // Fetch user badges
    const badgeResult = await query(`
      SELECT role FROM users WHERE id = $1
    `, [userId]);

    info.role = badgeResult.rows[0]?.role || 'user';

    ws.send(JSON.stringify({
      type: 'auth_success',
      userId,
      username,
      role: info.role
    }));

    logChatEvent('auth', null, { user_id: userId, username });
  } else {
    // Guest user
    info.userId = null;
    info.username = `Guest_${info.clientId.slice(0, 6)}`;
    ws.send(JSON.stringify({
      type: 'auth_success',
      userId: null,
      username: info.username,
      isGuest: true
    }));
  }
}

async function handleJoin(ws, info, message) {
  const { channelId } = message;
  if (!channelId) return;

  // Add to channel room
  if (!channelClients.has(channelId)) {
    channelClients.set(channelId, new Set());
    // Subscribe to Redis channel for this room
    await subscribe(`chat:${channelId}`, (msg) => {
      broadcastToChannel(channelId, msg);
    });
  }
  channelClients.get(channelId).add(ws);
  info.channels.add(channelId);

  // Fetch recent messages
  const recentMessages = await query(`
    SELECT cm.id, cm.message, cm.username, cm.badges, cm.created_at,
           cm.user_id, u.display_name, u.avatar_url
    FROM chat_messages cm
    LEFT JOIN users u ON cm.user_id = u.id
    WHERE cm.channel_id = $1 AND cm.is_deleted = FALSE
    ORDER BY cm.created_at DESC
    LIMIT 50
  `, [channelId]);

  ws.send(JSON.stringify({
    type: 'joined',
    channelId,
    recentMessages: recentMessages.rows.reverse(),
    viewerCount: channelClients.get(channelId).size
  }));

  // Notify room of new viewer
  broadcastToChannel(channelId, {
    type: 'viewer_update',
    channelId,
    viewerCount: channelClients.get(channelId).size
  });

  logChatEvent('join', channelId, { user_id: info.userId, username: info.username });
}

async function handleLeave(ws, info, message) {
  const { channelId } = message;
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
        viewerCount: clients.size
      });
    }
  }

  ws.send(JSON.stringify({ type: 'left', channelId }));
  logChatEvent('leave', channelId, { user_id: info.userId });
}

async function handleChat(ws, info, message) {
  const { channelId, text, messageId: clientMessageId } = message;

  if (!channelId || !text || text.trim().length === 0) {
    ws.send(JSON.stringify({ type: 'error', message: 'Invalid message' }));
    return;
  }

  // Check if user is authenticated (guests can still chat)
  if (!info.username) {
    ws.send(JSON.stringify({ type: 'error', message: 'Not authenticated' }));
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
      message: `Slow down! Wait ${Math.ceil(rateCheck.waitMs / 1000)}s`
    }));
    return;
  }

  // Check if user is banned
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
  const badges = [];
  if (info.role === 'admin') badges.push({ type: 'admin', label: 'Admin' });
  if (info.role === 'moderator') badges.push({ type: 'mod', label: 'Moderator' });

  // Check if subscriber
  if (info.userId) {
    const subCheck = await query(`
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

  const chatMessage = {
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
    await redisChatBreaker.fire(`chat:${channelId}`, chatMessage);
  } catch (error) {
    // Circuit breaker is open or fallback was used
    logger.warn({
      channel_id: channelId,
      error: error.message
    }, 'Chat publish via circuit breaker fallback');
  }

  // Update metrics
  incChatMessage(channelId);
}

function broadcastToChannel(channelId, message) {
  const clients = channelClients.get(channelId);
  if (!clients) return;

  const data = JSON.stringify(message);
  clients.forEach(client => {
    if (client.readyState === 1) { // WebSocket.OPEN
      client.send(data);
    }
  });
}

function setupRedisSubscriptions(redisClient) {
  // This is already handled per-channel in handleJoin
  // but we could add global subscriptions here
}

module.exports = { setupChatWebSocket };
