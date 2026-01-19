import { v4 as uuidv4 } from 'uuid';
import { config } from '../config.js';
import { redisPub, KEYS } from '../redis.js';
import { getUserServer } from '../services/userService.js';
import {
  isUserInConversation,
  getConversationParticipants,
  getConversationById,
} from '../services/conversationService.js';
import { createMessage } from '../services/messageService.js';
import { WSChatMessage } from '../types/index.js';
import { createServiceLogger, LogEvents, logEvent } from '../shared/logger.js';
import { recordMessage, recordDeliveryDuration } from '../shared/metrics.js';
import { withRedisCircuit } from '../shared/circuitBreaker.js';
import { retryMessageDelivery } from '../shared/retry.js';
import { startDeliveryTracking, recordDelivery, idempotentStatusUpdate } from '../shared/deliveryTracker.js';
import { AuthenticatedSocket } from './types.js';
import { getConnection, sendToSocket } from './connection-manager.js';

const wsLogger = createServiceLogger('websocket-chat');

/**
 * Chat Handler Module
 *
 * @description Handles the core chat message sending flow including persistence,
 * acknowledgment, and delivery to all conversation participants. Manages both
 * local delivery and cross-server routing via Redis pub/sub.
 *
 * @module chat-handler
 */

/**
 * Handles sending a chat message from a WebSocket client.
 *
 * @description Processes an incoming chat message through the complete send flow:
 * 1. Validates sender is a participant in the conversation
 * 2. Persists message to database with retry logic
 * 3. Starts delivery tracking for metrics
 * 4. Sends acknowledgment to sender with message ID
 * 5. Delivers to all other participants (locally or via Redis)
 *
 * On error, sends an error response to the sender and records failure metrics.
 *
 * @param socket - The authenticated WebSocket connection of the message sender
 * @param message - The chat message payload containing conversationId and content
 * @returns Promise that resolves when message processing is complete
 * @throws Logs error but does not throw - errors are sent to client as error messages
 *
 * @example
 * ```typescript
 * // Incoming WebSocket message
 * const wsMessage: WSChatMessage = {
 *   type: 'message',
 *   clientMessageId: 'client-uuid-123',
 *   payload: {
 *     conversationId: 'conv-456',
 *     content: 'Hello!',
 *     contentType: 'text'
 *   }
 * };
 *
 * await handleChatMessage(socket, wsMessage);
 * // Sender receives: { type: 'message_ack', payload: { messageId, status: 'sent' } }
 * // Recipients receive: { type: 'message', payload: { ...savedMessage } }
 * ```
 */
export async function handleChatMessage(
  socket: AuthenticatedSocket,
  message: WSChatMessage
): Promise<void> {
  const userId = socket.userId;
  const { conversationId, content, contentType, mediaUrl } = message.payload;
  const clientMessageId = message.clientMessageId || uuidv4();
  const sendStartTime = Date.now();

  try {
    const isParticipant = await isUserInConversation(userId, conversationId);
    if (!isParticipant) {
      sendToSocket(socket, {
        type: 'error',
        payload: { message: 'Not a participant in this conversation', clientMessageId },
      });
      recordMessage('failed', contentType || 'text');
      return;
    }

    const savedMessage = await retryMessageDelivery(
      () => createMessage(conversationId, userId, content, contentType || 'text', mediaUrl),
      clientMessageId,
      userId
    );

    await startDeliveryTracking(savedMessage.id, userId);
    sendToSocket(socket, {
      type: 'message_ack',
      payload: { clientMessageId, messageId: savedMessage.id, status: 'sent', createdAt: savedMessage.created_at },
    });

    logEvent(LogEvents.MESSAGE_SENT, {
      message_id: savedMessage.id,
      conversation_id: conversationId,
      sender_id: userId,
      content_type: contentType || 'text',
    });

    const conversation = await getConversationById(conversationId);
    const participants = await getConversationParticipants(conversationId);
    await deliverToParticipants(socket, userId, conversationId, savedMessage, conversation, participants, sendStartTime);
  } catch (error) {
    wsLogger.error({ error, conversationId, userId }, 'Error handling chat message');
    recordMessage('failed', contentType || 'text');
    sendToSocket(socket, { type: 'error', payload: { message: 'Failed to send message', clientMessageId } });
  }
}

/**
 * Delivers a message to all conversation participants except the sender.
 *
 * @description Iterates through participants, determines their server location,
 * and routes delivery appropriately (locally or via Redis pub/sub).
 *
 * @param socket - The sender's socket for sending delivery receipts
 * @param userId - The sender's user ID
 * @param conversationId - The conversation ID
 * @param savedMessage - The persisted message with ID and timestamp
 * @param conversation - The conversation metadata (name, group status)
 * @param participants - Array of conversation participants
 * @param sendStartTime - Timestamp when send was initiated (for latency tracking)
 * @returns Promise that resolves when all delivery attempts complete
 * @internal
 */
async function deliverToParticipants(
  socket: AuthenticatedSocket,
  userId: string,
  conversationId: string,
  savedMessage: { id: string; created_at: Date },
  conversation: { name?: string; is_group?: boolean } | null,
  participants: Array<{ user_id: string; user?: unknown }>,
  sendStartTime: number
): Promise<void> {
  for (const participant of participants) {
    if (participant.user_id === userId) continue;

    const recipientServer = await getUserServer(participant.user_id);
    const messagePayload = {
      ...savedMessage,
      sender: participant.user,
      conversation: { id: conversationId, name: conversation?.name, is_group: conversation?.is_group },
    };

    if (recipientServer === config.serverId) {
      await deliverLocally(socket, participant.user_id, savedMessage.id, messagePayload, sendStartTime);
    } else if (recipientServer) {
      await deliverViaRedis(userId, participant.user_id, recipientServer, savedMessage.id, messagePayload, sendStartTime);
    }
  }
}

/**
 * Delivers a message to a recipient connected to this server.
 *
 * @description Sends message directly to locally connected recipient and handles
 * delivery receipt generation. Uses idempotent status updates to prevent
 * duplicate receipts.
 *
 * @param senderSocket - The sender's socket for receiving delivery receipt
 * @param recipientId - The recipient's user ID
 * @param messageId - The message ID being delivered
 * @param payload - The full message payload
 * @param sendStartTime - Timestamp for delivery latency calculation
 * @returns Promise that resolves when delivery and receipt are complete
 * @internal
 */
async function deliverLocally(
  senderSocket: AuthenticatedSocket,
  recipientId: string,
  messageId: string,
  payload: unknown,
  sendStartTime: number
): Promise<void> {
  const recipientSocket = getConnection(recipientId);
  if (!recipientSocket) return;

  sendToSocket(recipientSocket, { type: 'message', payload });

  const wasUpdated = await idempotentStatusUpdate(messageId, recipientId, 'delivered');
  if (wasUpdated) {
    recordDeliveryDuration((Date.now() - sendStartTime) / 1000, 'local');
    await recordDelivery(messageId, recipientId, 'local');
    sendToSocket(senderSocket, {
      type: 'delivery_receipt',
      payload: { messageId, recipientId, status: 'delivered', timestamp: new Date() },
    });
  }
}

/**
 * Routes a message through Redis pub/sub to another server.
 *
 * @description Publishes a message delivery request to the recipient's server
 * channel. The target server will handle local delivery and send back
 * delivery receipts through Redis.
 *
 * @param senderId - The sender's user ID (for receipt routing)
 * @param recipientId - The recipient's user ID
 * @param recipientServer - The server ID where the recipient is connected
 * @param messageId - The message ID being delivered
 * @param payload - The full message payload
 * @param sendStartTime - Timestamp for cross-server latency tracking
 * @returns Promise that resolves when message is published to Redis
 * @internal
 */
async function deliverViaRedis(
  senderId: string,
  recipientId: string,
  recipientServer: string,
  messageId: string,
  payload: unknown,
  sendStartTime: number
): Promise<void> {
  await withRedisCircuit(async () => {
    await redisPub.publish(
      KEYS.serverChannel(recipientServer),
      JSON.stringify({
        type: 'deliver_message',
        recipientId,
        senderId,
        senderServer: config.serverId,
        messageId,
        sendStartTime,
        payload,
      })
    );
  });
}
