/**
 * @fileoverview Direct Message service using Cassandra.
 * Handles conversation creation, message sending, and inbox queries.
 */

import {
  getCassandraClient,
  isCassandraConnected,
  generateTimeUuid,
  toUuid,
  generateUserPairKey,
  types,
} from './cassandra.js';
import { logger } from './logger.js';

/**
 * Get or create a conversation between two users.
 * @param {string} userId1 - First user UUID
 * @param {string} userId2 - Second user UUID
 * @param {object} user1Info - First user info { username, profilePicture }
 * @param {object} user2Info - Second user info { username, profilePicture }
 * @returns {Promise<string>} Conversation UUID
 */
export async function getOrCreateConversation(userId1, userId2, user1Info, user2Info) {
  if (!isCassandraConnected()) {
    throw new Error('Cassandra not connected');
  }

  const client = getCassandraClient();
  const userPairKey = generateUserPairKey(userId1, userId2);

  // Check if conversation exists
  const lookupQuery = 'SELECT conversation_id FROM user_conversation_lookup WHERE user_id_pair = ?';
  const lookupResult = await client.execute(lookupQuery, [userPairKey], { prepare: true });

  if (lookupResult.rowCount > 0) {
    return lookupResult.rows[0].conversation_id.toString();
  }

  // Create new conversation
  const conversationId = types.Uuid.random();
  const now = new Date();

  // Insert into lookup table
  const insertLookup = `
    INSERT INTO user_conversation_lookup (user_id_pair, conversation_id, created_at)
    VALUES (?, ?, ?)
  `;
  await client.execute(insertLookup, [userPairKey, conversationId, now], { prepare: true });

  // Insert participants
  const insertParticipant = `
    INSERT INTO conversation_participants (conversation_id, user_id, username, profile_picture, joined_at, is_admin)
    VALUES (?, ?, ?, ?, ?, ?)
  `;
  await client.execute(
    insertParticipant,
    [conversationId, toUuid(userId1), user1Info.username, user1Info.profilePicture, now, false],
    { prepare: true }
  );
  await client.execute(
    insertParticipant,
    [conversationId, toUuid(userId2), user2Info.username, user2Info.profilePicture, now, false],
    { prepare: true }
  );

  // Initialize conversation for both users
  const insertConversation = `
    INSERT INTO conversations_by_user (
      user_id, last_message_at, conversation_id, other_user_id,
      other_username, other_profile_picture, last_message_preview,
      last_message_sender_id, unread_count, is_muted
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;

  await client.execute(
    insertConversation,
    [
      toUuid(userId1), now, conversationId, toUuid(userId2),
      user2Info.username, user2Info.profilePicture, '',
      null, 0, false,
    ],
    { prepare: true }
  );

  await client.execute(
    insertConversation,
    [
      toUuid(userId2), now, conversationId, toUuid(userId1),
      user1Info.username, user1Info.profilePicture, '',
      null, 0, false,
    ],
    { prepare: true }
  );

  logger.info({ conversationId: conversationId.toString(), userId1, userId2 }, 'Created new conversation');
  return conversationId.toString();
}

/**
 * Send a message in a conversation.
 * @param {object} params - Message parameters
 * @param {string} params.conversationId - Conversation UUID
 * @param {string} params.senderId - Sender user UUID
 * @param {string} params.content - Message content
 * @param {string} [params.contentType='text'] - Content type
 * @param {string} [params.mediaUrl] - Media URL if applicable
 * @param {string} [params.replyToMessageId] - Reply-to message ID
 * @returns {Promise<object>} Created message
 */
export async function sendMessage({
  conversationId,
  senderId,
  content,
  contentType = 'text',
  mediaUrl = null,
  replyToMessageId = null,
}) {
  if (!isCassandraConnected()) {
    throw new Error('Cassandra not connected');
  }

  const client = getCassandraClient();
  const messageId = generateTimeUuid();
  const now = new Date();

  // Insert message
  const insertMessage = `
    INSERT INTO messages_by_conversation (
      conversation_id, message_id, sender_id, content,
      content_type, media_url, reply_to_message_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `;

  await client.execute(
    insertMessage,
    [
      toUuid(conversationId), messageId, toUuid(senderId),
      content, contentType, mediaUrl,
      replyToMessageId ? types.TimeUuid.fromString(replyToMessageId) : null,
      now,
    ],
    { prepare: true }
  );

  // Get all participants to update their conversation view
  const participantsQuery = 'SELECT user_id FROM conversation_participants WHERE conversation_id = ?';
  const participantsResult = await client.execute(participantsQuery, [toUuid(conversationId)], { prepare: true });

  // Update conversation for each participant
  const preview = content.substring(0, 100);
  for (const row of participantsResult.rows) {
    const participantId = row.user_id.toString();

    // Delete old entry (need to find it first by querying)
    const findOldQuery = `
      SELECT last_message_at FROM conversations_by_user
      WHERE user_id = ? AND conversation_id = ?
      ALLOW FILTERING
    `;
    const oldEntry = await client.execute(findOldQuery, [row.user_id, toUuid(conversationId)], { prepare: true });

    if (oldEntry.rowCount > 0) {
      const deleteOld = `
        DELETE FROM conversations_by_user
        WHERE user_id = ? AND last_message_at = ? AND conversation_id = ?
      `;
      await client.execute(deleteOld, [row.user_id, oldEntry.rows[0].last_message_at, toUuid(conversationId)], {
        prepare: true,
      });
    }

    // Get other user info for this participant
    const otherParticipant = participantsResult.rows.find(
      (p) => p.user_id.toString() !== participantId
    );

    // Insert updated entry with new timestamp
    const insertConv = `
      INSERT INTO conversations_by_user (
        user_id, last_message_at, conversation_id, other_user_id,
        other_username, other_profile_picture, last_message_preview,
        last_message_sender_id, unread_count, is_muted
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    const unreadCount = participantId === senderId ? 0 : 1; // Sender has 0 unread

    await client.execute(
      insertConv,
      [
        row.user_id, now, toUuid(conversationId),
        otherParticipant?.user_id || null,
        '', '', // Username/profile will be fetched from participants table
        preview, toUuid(senderId), unreadCount, false,
      ],
      { prepare: true }
    );
  }

  logger.info({ conversationId, messageId: messageId.toString(), senderId }, 'Message sent');

  return {
    messageId: messageId.toString(),
    conversationId,
    senderId,
    content,
    contentType,
    mediaUrl,
    createdAt: now.toISOString(),
  };
}

/**
 * Get messages in a conversation.
 * @param {string} conversationId - Conversation UUID
 * @param {object} [options] - Query options
 * @param {number} [options.limit=50] - Max messages to return
 * @param {string} [options.beforeMessageId] - Get messages before this ID
 * @returns {Promise<object[]>} Messages
 */
export async function getMessages(conversationId, options = {}) {
  if (!isCassandraConnected()) {
    throw new Error('Cassandra not connected');
  }

  const client = getCassandraClient();
  const { limit = 50, beforeMessageId } = options;

  let query;
  let params;

  if (beforeMessageId) {
    query = `
      SELECT * FROM messages_by_conversation
      WHERE conversation_id = ? AND message_id < ?
      LIMIT ?
    `;
    params = [toUuid(conversationId), types.TimeUuid.fromString(beforeMessageId), limit];
  } else {
    query = `
      SELECT * FROM messages_by_conversation
      WHERE conversation_id = ?
      LIMIT ?
    `;
    params = [toUuid(conversationId), limit];
  }

  const result = await client.execute(query, params, { prepare: true });

  return result.rows.map((row) => ({
    messageId: row.message_id.toString(),
    conversationId: row.conversation_id.toString(),
    senderId: row.sender_id.toString(),
    content: row.content,
    contentType: row.content_type,
    mediaUrl: row.media_url,
    replyToMessageId: row.reply_to_message_id?.toString() || null,
    createdAt: row.created_at.toISOString(),
  }));
}

/**
 * Get user's conversations (inbox).
 * @param {string} userId - User UUID
 * @param {object} [options] - Query options
 * @param {number} [options.limit=20] - Max conversations to return
 * @returns {Promise<object[]>} Conversations
 */
export async function getConversations(userId, options = {}) {
  if (!isCassandraConnected()) {
    throw new Error('Cassandra not connected');
  }

  const client = getCassandraClient();
  const { limit = 20 } = options;

  const query = `
    SELECT * FROM conversations_by_user
    WHERE user_id = ?
    LIMIT ?
  `;

  const result = await client.execute(query, [toUuid(userId), limit], { prepare: true });

  return result.rows.map((row) => ({
    conversationId: row.conversation_id.toString(),
    otherUserId: row.other_user_id?.toString() || null,
    otherUsername: row.other_username,
    otherProfilePicture: row.other_profile_picture,
    lastMessagePreview: row.last_message_preview,
    lastMessageSenderId: row.last_message_sender_id?.toString() || null,
    lastMessageAt: row.last_message_at.toISOString(),
    unreadCount: row.unread_count,
    isMuted: row.is_muted,
  }));
}

/**
 * Mark conversation as read.
 * @param {string} conversationId - Conversation UUID
 * @param {string} userId - User UUID
 * @param {string} lastMessageId - Last read message TimeUUID
 * @returns {Promise<void>}
 */
export async function markConversationRead(conversationId, userId, lastMessageId) {
  if (!isCassandraConnected()) {
    throw new Error('Cassandra not connected');
  }

  const client = getCassandraClient();
  const now = new Date();

  // Update read receipt
  const insertReceipt = `
    INSERT INTO message_read_receipts (conversation_id, user_id, last_read_message_id, last_read_at)
    VALUES (?, ?, ?, ?)
  `;
  await client.execute(
    insertReceipt,
    [toUuid(conversationId), toUuid(userId), types.TimeUuid.fromString(lastMessageId), now],
    { prepare: true }
  );

  // Reset unread count - need to update the conversation entry
  // This is a simplification; in production, you'd update the specific row
  logger.info({ conversationId, userId }, 'Marked conversation as read');
}

/**
 * Set typing indicator.
 * @param {string} conversationId - Conversation UUID
 * @param {string} userId - User UUID
 * @returns {Promise<void>}
 */
export async function setTypingIndicator(conversationId, userId) {
  if (!isCassandraConnected()) {
    throw new Error('Cassandra not connected');
  }

  const client = getCassandraClient();

  const query = `
    INSERT INTO typing_indicators (conversation_id, user_id, started_at)
    VALUES (?, ?, ?)
  `;
  await client.execute(query, [toUuid(conversationId), toUuid(userId), new Date()], { prepare: true });
}

/**
 * Get typing indicators for a conversation.
 * @param {string} conversationId - Conversation UUID
 * @returns {Promise<string[]>} User IDs currently typing
 */
export async function getTypingIndicators(conversationId) {
  if (!isCassandraConnected()) {
    throw new Error('Cassandra not connected');
  }

  const client = getCassandraClient();

  const query = 'SELECT user_id FROM typing_indicators WHERE conversation_id = ?';
  const result = await client.execute(query, [toUuid(conversationId)], { prepare: true });

  return result.rows.map((row) => row.user_id.toString());
}

/**
 * Add reaction to a message.
 * @param {string} conversationId - Conversation UUID
 * @param {string} messageId - Message TimeUUID
 * @param {string} userId - User UUID
 * @param {string} reaction - Reaction type
 * @returns {Promise<void>}
 */
export async function addReaction(conversationId, messageId, userId, reaction) {
  if (!isCassandraConnected()) {
    throw new Error('Cassandra not connected');
  }

  const client = getCassandraClient();

  const query = `
    INSERT INTO message_reactions (conversation_id, message_id, user_id, reaction, created_at)
    VALUES (?, ?, ?, ?, ?)
  `;
  await client.execute(
    query,
    [toUuid(conversationId), types.TimeUuid.fromString(messageId), toUuid(userId), reaction, new Date()],
    { prepare: true }
  );

  logger.info({ conversationId, messageId, userId, reaction }, 'Added reaction');
}

/**
 * Remove reaction from a message.
 * @param {string} conversationId - Conversation UUID
 * @param {string} messageId - Message TimeUUID
 * @param {string} userId - User UUID
 * @returns {Promise<void>}
 */
export async function removeReaction(conversationId, messageId, userId) {
  if (!isCassandraConnected()) {
    throw new Error('Cassandra not connected');
  }

  const client = getCassandraClient();

  const query = `
    DELETE FROM message_reactions
    WHERE conversation_id = ? AND message_id = ? AND user_id = ?
  `;
  await client.execute(
    query,
    [toUuid(conversationId), types.TimeUuid.fromString(messageId), toUuid(userId)],
    { prepare: true }
  );
}
