import { config } from '../config.js';
import { redis, redisPub, KEYS } from '../redis.js';
import { getUserServer } from '../services/userService.js';
import { getConversationParticipants } from '../services/conversationService.js';
import { markConversationAsRead } from '../services/messageService.js';
import { WSTypingMessage, WSReadReceiptMessage } from '../types/index.js';
import { createServiceLogger } from '../shared/logger.js';
import { recordMessage } from '../shared/metrics.js';
import { withRedisCircuit } from '../shared/circuitBreaker.js';
import { AuthenticatedSocket } from './types.js';
import { getConnection, sendToSocket } from './connection-manager.js';
import { notifyDeliveryReceipt } from './presence.js';

const wsLogger = createServiceLogger('websocket-typing');

/**
 * Typing Handler Module
 *
 * @description Handles typing indicators and read receipts for real-time chat features.
 * Typing state is stored in Redis with auto-expiry and broadcast to all participants.
 * Read receipts trigger database updates and sender notifications.
 *
 * @module typing-handler
 */

/**
 * Handles typing indicator events from WebSocket clients.
 *
 * @description Processes typing start and stop events:
 * 1. Drops the event unless the sender is a participant (same rule as sending a message)
 * 2. Stores typing state in Redis with 5-second auto-expiry (handles abandoned typing)
 * 3. Broadcasts typing status to all other conversation participants
 * 4. Routes to local connections or via Redis pub/sub for cross-server delivery
 *
 * Typing indicators are ephemeral and do not persist beyond the Redis TTL.
 *
 * @param socket - The authenticated WebSocket connection of the typing user
 * @param message - The typing message containing conversationId and type (typing/stop_typing)
 * @returns Promise that resolves when all participants are notified
 * @throws Logs error but does not throw - typing failures are silently handled
 *
 * @example
 * ```typescript
 * // User starts typing
 * await handleTyping(socket, {
 *   type: 'typing',
 *   payload: { conversationId: 'conv-123' }
 * });
 *
 * // User stops typing
 * await handleTyping(socket, {
 *   type: 'stop_typing',
 *   payload: { conversationId: 'conv-123' }
 * });
 * ```
 */
export async function handleTyping(
  socket: AuthenticatedSocket,
  message: WSTypingMessage
): Promise<void> {
  const userId = socket.userId;
  const conversationId = message.payload?.conversationId;
  const isTyping = message.type === 'typing';
  if (typeof conversationId !== 'string') return;

  try {
    // Get participants first: only a participant may signal typing in a conversation
    const participants = await getConversationParticipants(conversationId);
    if (!participants.some((participant) => participant.user_id === userId)) {
      sendToSocket(socket, {
        type: 'error',
        payload: { message: 'Not a participant in this conversation', conversationId },
      });
      return;
    }

    // Store typing state briefly with circuit breaker
    await withRedisCircuit(async () => {
      if (isTyping) {
        await redis.setex(KEYS.typing(conversationId, userId), 5, '1');
      } else {
        await redis.del(KEYS.typing(conversationId, userId));
      }
    });

    // Notify the other participants
    for (const participant of participants) {
      if (participant.user_id === userId) continue;

      const recipientServer = await getUserServer(participant.user_id);
      const typingPayload = {
        type: message.type,
        payload: { conversationId, userId },
      };

      if (recipientServer === config.serverId) {
        const recipientSocket = getConnection(participant.user_id);
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
 * Handles read receipt events from WebSocket clients.
 *
 * @description Processes read receipt requests:
 * 1. Marks all unread messages in the conversation as read (idempotent)
 * 2. Records read metrics for each marked message
 * 3. Notifies all other participants about the read status
 *
 * Uses idempotent database updates to prevent duplicate processing.
 * Only notifies senders if messages were actually newly marked as read.
 *
 * @param socket - The authenticated WebSocket connection of the reading user
 * @param message - The read receipt message containing the conversationId
 * @returns Promise that resolves when all updates and notifications are complete
 * @throws Logs error but does not throw - failures are handled gracefully
 *
 * @example
 * ```typescript
 * // User opens a conversation (marks all messages as read)
 * await handleReadReceipt(socket, {
 *   type: 'read_receipt',
 *   payload: { conversationId: 'conv-123' }
 * });
 * // All senders in conv-123 receive read receipts for their messages
 * ```
 */
export async function handleReadReceipt(
  socket: AuthenticatedSocket,
  message: WSReadReceiptMessage
): Promise<void> {
  const userId = socket.userId;
  const { conversationId } = message.payload;

  try {
    // Mark messages as read with idempotent updates
    const markedIds = await markConversationAsRead(conversationId, userId);

    if (markedIds.length === 0) return;

    // Record read metrics
    for (const _id of markedIds) {
      recordMessage('read', 'text');
    }

    // Get participants to notify senders
    const participants = await getConversationParticipants(conversationId);

    // Notify the senders of the read messages
    for (const participant of participants) {
      if (participant.user_id === userId) continue;

      await notifyDeliveryReceipt(
        participant.user_id,
        markedIds[0],
        userId,
        'read',
        markedIds
      );
    }
  } catch (error) {
    wsLogger.error({ error, conversationId, userId }, 'Error handling read receipt');
  }
}
