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
 * Handles typing indicators and read receipts.
 * Stores typing state in Redis with auto-expiry and broadcasts to participants.
 */

/**
 * Handles typing indicator events.
 * Stores typing state in Redis with auto-expiry and broadcasts to participants.
 */
export async function handleTyping(
  socket: AuthenticatedSocket,
  message: WSTypingMessage
): Promise<void> {
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
 * Handles read receipt events.
 * Marks messages as read in database and notifies senders.
 * Uses idempotent updates to prevent duplicate processing.
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
