import { config } from '../config.js';
import { redisPub, KEYS } from '../redis.js';
import { getUserServer } from '../services/userService.js';
import { getConversationParticipants } from '../services/conversationService.js';
import { withRedisCircuit } from '../shared/circuitBreaker.js';
import { createServiceLogger } from '../shared/logger.js';
import { getAllConnections, getConnection, sendToSocket } from './connection-manager.js';
import { ReactionSummary } from '../types/index.js';

const wsLogger = createServiceLogger('websocket-presence');

/**
 * Presence Module
 *
 * @description Handles user online/offline status broadcasting and reaction updates.
 * Uses Redis pub/sub for cross-server communication to ensure all connected
 * users receive real-time presence and reaction notifications.
 *
 * @module presence
 */

/**
 * Broadcasts a user's presence change to all connected users on this server.
 *
 * @description Notifies all locally connected users when another user comes online
 * or goes offline. This enables real-time presence indicators in the UI.
 * Does not notify the user about their own presence change.
 *
 * @param userId - The unique identifier of the user whose presence changed
 * @param status - The new presence status ('online' or 'offline')
 * @returns Promise that resolves when all notifications are sent
 *
 * @example
 * ```typescript
 * // When user connects
 * await broadcastPresence(userId, 'online');
 *
 * // When user disconnects
 * await broadcastPresence(userId, 'offline');
 * ```
 */
export async function broadcastPresence(
  userId: string,
  status: 'online' | 'offline'
): Promise<void> {
  const presencePayload = {
    type: 'presence',
    payload: {
      userId,
      status,
      timestamp: Date.now(),
    },
  };

  // Broadcast to all connected users on this server
  for (const [connectedUserId, socket] of getAllConnections()) {
    if (connectedUserId !== userId) {
      sendToSocket(socket, presencePayload);
    }
  }
}

/**
 * Sends a delivery or read receipt to a message sender.
 *
 * @description Routes receipt notifications to the original message sender.
 * First checks if the sender is on this server for local delivery, otherwise
 * publishes to Redis for cross-server routing. Used to update message status
 * indicators (single check, double check, blue check) in the UI.
 *
 * @param recipientUserId - The user ID of the message sender to notify
 * @param messageId - The unique identifier of the message that was delivered/read
 * @param readerId - The user ID who received/read the message
 * @param status - The new status: 'delivered' or 'read'
 * @param allMessageIds - Optional array of all message IDs being marked (for batch updates)
 * @returns Promise that resolves when the notification is sent/queued
 *
 * @example
 * ```typescript
 * // Notify sender that message was delivered
 * await notifyDeliveryReceipt(senderId, messageId, recipientId, 'delivered');
 *
 * // Notify sender that all messages were read
 * await notifyDeliveryReceipt(senderId, messageIds[0], recipientId, 'read', messageIds);
 * ```
 */
export async function notifyDeliveryReceipt(
  recipientUserId: string,
  messageId: string,
  readerId: string,
  status: 'delivered' | 'read',
  allMessageIds?: string[]
): Promise<void> {
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
    const recipientSocket = getConnection(recipientUserId);
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
 * Broadcasts a reaction update to all participants in a conversation.
 *
 * @description Called when a reaction is added or removed via the REST API.
 * Delivers the updated reaction state to all conversation participants.
 * Uses local delivery for same-server recipients and Redis pub/sub for others.
 *
 * @param conversationId - The unique identifier of the conversation containing the message
 * @param messageId - The unique identifier of the message that was reacted to
 * @param reactions - Array of updated reaction summaries (emoji + count + users)
 * @param actorId - The user ID who added or removed the reaction
 * @returns Promise that resolves when all notifications are sent/queued
 * @throws Logs error but does not throw - failures are handled gracefully
 *
 * @example
 * ```typescript
 * // After adding a reaction via REST API
 * await broadcastReactionUpdate(
 *   conversationId,
 *   messageId,
 *   [{ emoji: '👍', count: 3, userIds: ['user1', 'user2', 'user3'] }],
 *   actorUserId
 * );
 * ```
 */
export async function broadcastReactionUpdate(
  conversationId: string,
  messageId: string,
  reactions: ReactionSummary[],
  actorId: string
): Promise<void> {
  try {
    const participants = await getConversationParticipants(conversationId);

    const reactionPayload = {
      type: 'reaction_update',
      payload: {
        conversationId,
        messageId,
        reactions,
        actorId,
        timestamp: new Date(),
      },
    };

    for (const participant of participants) {
      const recipientServer = await getUserServer(participant.user_id);

      if (recipientServer === config.serverId) {
        // Local delivery
        const recipientSocket = getConnection(participant.user_id);
        if (recipientSocket) {
          sendToSocket(recipientSocket, reactionPayload);
        }
      } else if (recipientServer) {
        // Route through Redis pub/sub to other server
        await withRedisCircuit(async () => {
          await redisPub.publish(
            KEYS.serverChannel(recipientServer),
            JSON.stringify({
              type: 'forward_reaction',
              recipientId: participant.user_id,
              payload: reactionPayload,
            })
          );
        });
      }
    }
  } catch (error) {
    wsLogger.error(
      { error, conversationId, messageId },
      'Error broadcasting reaction update'
    );
  }
}
