import { v4 as uuid } from 'uuid';
import { query, transaction } from '../db.js';
import { queueOfflineMessage, getUserConnections } from '../redis.js';
import { getParticipantIds } from './conversations.js';
import { createLogger } from '../shared/logger.js';
import {
  messagesTotal,
  messageDeliveryDuration,
  messageDeliveryStatus,
  syncLatency,
  dbQueryDuration,
} from '../shared/metrics.js';
import idempotencyService from '../shared/idempotency.js';

const logger = createLogger('messages-service');

export async function getMessages(conversationId, userId, options = {}) {
  const { limit = 50, before, after } = options;

  let sql = `
    SELECT
      m.id,
      m.conversation_id,
      m.sender_id,
      m.content,
      m.content_type,
      m.reply_to_id,
      m.edited_at,
      m.created_at,
      u.username as sender_username,
      u.display_name as sender_display_name,
      u.avatar_url as sender_avatar_url,
      (
        SELECT json_agg(json_build_object(
          'id', r.id,
          'user_id', r.user_id,
          'reaction', r.reaction
        ))
        FROM reactions r WHERE r.message_id = m.id
      ) as reactions,
      (
        SELECT json_build_object(
          'id', rm.id,
          'content', rm.content,
          'sender_id', rm.sender_id
        )
        FROM messages rm WHERE rm.id = m.reply_to_id
      ) as reply_to
    FROM messages m
    JOIN users u ON u.id = m.sender_id
    WHERE m.conversation_id = $1 AND m.deleted_at IS NULL
  `;

  const params = [conversationId];
  let paramIndex = 2;

  if (before) {
    sql += ` AND m.created_at < $${paramIndex}`;
    params.push(before);
    paramIndex++;
  }

  if (after) {
    sql += ` AND m.created_at > $${paramIndex}`;
    params.push(after);
    paramIndex++;
  }

  sql += ` ORDER BY m.created_at DESC LIMIT $${paramIndex}`;
  params.push(limit);

  const result = await query(sql, params);

  // Reverse to get chronological order
  return result.rows.reverse();
}

export async function getMessage(messageId) {
  const result = await query(
    `SELECT
      m.id,
      m.conversation_id,
      m.sender_id,
      m.content,
      m.content_type,
      m.reply_to_id,
      m.edited_at,
      m.created_at,
      u.username as sender_username,
      u.display_name as sender_display_name,
      u.avatar_url as sender_avatar_url
    FROM messages m
    JOIN users u ON u.id = m.sender_id
    WHERE m.id = $1 AND m.deleted_at IS NULL`,
    [messageId]
  );

  return result.rows[0] || null;
}

export async function sendMessage(conversationId, senderId, content, options = {}) {
  const { contentType = 'text', replyToId, clientMessageId } = options;
  const startTime = Date.now();

  logger.debug({
    conversationId,
    senderId,
    contentType,
    hasClientMessageId: !!clientMessageId,
  }, 'Sending message');

  // Handle idempotency if client message ID is provided
  if (clientMessageId) {
    const idempotencyKey = idempotencyService.generateKey(senderId, conversationId, clientMessageId);

    const { result, isDuplicate } = await idempotencyService.processWithIdempotency({
      idempotencyKey,
      userId: senderId,
      operation: async () => {
        return await createMessage(conversationId, senderId, content, contentType, replyToId);
      },
    });

    if (isDuplicate) {
      messageDeliveryStatus.inc({ status: 'duplicate' });
      logger.info({ messageId: result.id, idempotencyKey }, 'Duplicate message detected');

      // Fetch the full message for the response
      const existingMessage = await getMessage(result.id);
      if (existingMessage) {
        return { ...existingMessage, isDuplicate: true };
      }
    }

    const duration = (Date.now() - startTime) / 1000;
    messageDeliveryDuration.observe({ status: 'success' }, duration);
    messagesTotal.inc({ status: 'sent', content_type: contentType });
    messageDeliveryStatus.inc({ status: 'delivered' });

    return result;
  }

  // No idempotency key - proceed with normal message creation
  try {
    const message = await createMessage(conversationId, senderId, content, contentType, replyToId);

    const duration = (Date.now() - startTime) / 1000;
    messageDeliveryDuration.observe({ status: 'success' }, duration);
    messagesTotal.inc({ status: 'sent', content_type: contentType });
    messageDeliveryStatus.inc({ status: 'delivered' });

    return message;
  } catch (error) {
    const duration = (Date.now() - startTime) / 1000;
    messageDeliveryDuration.observe({ status: 'failed' }, duration);
    messagesTotal.inc({ status: 'failed', content_type: contentType });
    messageDeliveryStatus.inc({ status: 'failed' });

    logger.error({ error, conversationId, senderId }, 'Failed to send message');
    throw error;
  }
}

/**
 * Internal function to create a message in the database
 */
async function createMessage(conversationId, senderId, content, contentType, replyToId) {
  const dbStart = Date.now();

  const result = await query(
    `INSERT INTO messages (conversation_id, sender_id, content, content_type, reply_to_id)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, conversation_id, sender_id, content, content_type, reply_to_id, created_at`,
    [conversationId, senderId, content, contentType, replyToId]
  );

  dbQueryDuration.observe({ operation: 'insert_message' }, (Date.now() - dbStart) / 1000);

  const message = result.rows[0];

  // Update conversation timestamp
  await query(
    'UPDATE conversations SET updated_at = NOW() WHERE id = $1',
    [conversationId]
  );

  // Get sender info
  const senderResult = await query(
    'SELECT username, display_name, avatar_url FROM users WHERE id = $1',
    [senderId]
  );

  logger.debug({ messageId: message.id, conversationId }, 'Message created');

  return {
    ...message,
    sender_username: senderResult.rows[0].username,
    sender_display_name: senderResult.rows[0].display_name,
    sender_avatar_url: senderResult.rows[0].avatar_url,
    reactions: null,
    reply_to: null,
  };
}

export async function editMessage(messageId, userId, newContent) {
  const result = await query(
    `UPDATE messages
     SET content = $1, edited_at = NOW()
     WHERE id = $2 AND sender_id = $3 AND deleted_at IS NULL
     RETURNING id, conversation_id, content, edited_at`,
    [newContent, messageId, userId]
  );

  if (result.rows.length === 0) {
    throw new Error('Message not found or not authorized');
  }

  return result.rows[0];
}

export async function deleteMessage(messageId, userId) {
  const result = await query(
    `UPDATE messages
     SET deleted_at = NOW()
     WHERE id = $1 AND sender_id = $2
     RETURNING id, conversation_id`,
    [messageId, userId]
  );

  if (result.rows.length === 0) {
    throw new Error('Message not found or not authorized');
  }

  return result.rows[0];
}

export async function addReaction(messageId, userId, reaction) {
  const result = await query(
    `INSERT INTO reactions (message_id, user_id, reaction)
     VALUES ($1, $2, $3)
     ON CONFLICT (message_id, user_id, reaction) DO NOTHING
     RETURNING id, message_id, user_id, reaction`,
    [messageId, userId, reaction]
  );

  // Get the message's conversation for broadcasting
  const messageResult = await query(
    'SELECT conversation_id FROM messages WHERE id = $1',
    [messageId]
  );

  return {
    reaction: result.rows[0] || { message_id: messageId, user_id: userId, reaction },
    conversationId: messageResult.rows[0]?.conversation_id,
  };
}

export async function removeReaction(messageId, userId, reaction) {
  await query(
    'DELETE FROM reactions WHERE message_id = $1 AND user_id = $2 AND reaction = $3',
    [messageId, userId, reaction]
  );

  // Get the message's conversation for broadcasting
  const messageResult = await query(
    'SELECT conversation_id FROM messages WHERE id = $1',
    [messageId]
  );

  return {
    conversationId: messageResult.rows[0]?.conversation_id,
  };
}

export async function markAsRead(conversationId, userId, deviceId, messageId) {
  await query(
    `INSERT INTO read_receipts (user_id, device_id, conversation_id, last_read_message_id, last_read_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (user_id, device_id, conversation_id)
     DO UPDATE SET last_read_message_id = $4, last_read_at = NOW()`,
    [userId, deviceId, conversationId, messageId]
  );

  return { conversationId, userId, messageId };
}

export async function getReadReceipts(conversationId) {
  const result = await query(
    `SELECT DISTINCT ON (rr.user_id)
      rr.user_id,
      rr.last_read_message_id,
      rr.last_read_at,
      u.username,
      u.display_name,
      u.avatar_url
    FROM read_receipts rr
    JOIN users u ON u.id = rr.user_id
    WHERE rr.conversation_id = $1
    ORDER BY rr.user_id, rr.last_read_at DESC`,
    [conversationId]
  );

  return result.rows;
}

export async function getMessagesSince(conversationId, sinceTimestamp) {
  const result = await query(
    `SELECT
      m.id,
      m.conversation_id,
      m.sender_id,
      m.content,
      m.content_type,
      m.reply_to_id,
      m.edited_at,
      m.deleted_at,
      m.created_at,
      u.username as sender_username,
      u.display_name as sender_display_name,
      u.avatar_url as sender_avatar_url
    FROM messages m
    JOIN users u ON u.id = m.sender_id
    WHERE m.conversation_id = $1 AND m.created_at > $2
    ORDER BY m.created_at ASC`,
    [conversationId, sinceTimestamp]
  );

  return result.rows;
}

export async function getSyncCursor(deviceId, conversationId) {
  const result = await query(
    `SELECT last_synced_message_id, last_synced_at
     FROM sync_cursors
     WHERE device_id = $1 AND conversation_id = $2`,
    [deviceId, conversationId]
  );

  return result.rows[0] || null;
}

export async function updateSyncCursor(deviceId, conversationId, messageId) {
  await query(
    `INSERT INTO sync_cursors (device_id, conversation_id, last_synced_message_id, last_synced_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (device_id, conversation_id)
     DO UPDATE SET last_synced_message_id = $3, last_synced_at = NOW()`,
    [deviceId, conversationId, messageId]
  );
}
