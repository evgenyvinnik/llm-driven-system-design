import { config } from '../config.js';
import { redisPub, KEYS } from '../redis.js';
import { createServiceLogger } from '../shared/logger.js';
import { recordDeliveryDuration } from '../shared/metrics.js';
import { withRedisCircuit } from '../shared/circuitBreaker.js';
import { recordDelivery, idempotentStatusUpdate } from '../shared/deliveryTracker.js';
import { getConnection, sendToSocket } from './connection-manager.js';

const _wsLogger = createServiceLogger('websocket-redis');

/**
 * Redis Message Handler Module
 *
 * Handles messages received from Redis pub/sub for cross-server communication.
 * Processes message delivery, typing events, and receipts.
 */

/**
 * Data structure for Redis messages.
 */
export interface RedisMessageData {
  type: string;
  recipientId: string;
  senderId?: string;
  senderServer?: string;
  messageId?: string;
  sendStartTime?: number;
  payload?: unknown;
}

/**
 * Handles messages received from Redis pub/sub.
 * Processes cross-server message delivery, typing events, and receipts.
 *
 * @param data - The parsed message from Redis
 */
export async function handleRedisMessage(data: RedisMessageData): Promise<void> {
  switch (data.type) {
    case 'deliver_message':
      await handleDeliverMessage(data);
      break;

    case 'forward_typing':
    case 'forward_receipt':
    case 'forward_reaction':
      handleForwardMessage(data);
      break;
  }
}

/**
 * Handles cross-server message delivery.
 */
async function handleDeliverMessage(data: RedisMessageData): Promise<void> {
  const socket = getConnection(data.recipientId);
  if (!socket) return;

  sendToSocket(socket, {
    type: 'message',
    payload: data.payload,
  });

  const wasUpdated = await idempotentStatusUpdate(
    data.messageId!,
    data.recipientId,
    'delivered'
  );

  if (wasUpdated) {
    const deliveryDuration = (Date.now() - data.sendStartTime!) / 1000;
    recordDeliveryDuration(deliveryDuration, 'cross_server');

    await recordDelivery(data.messageId!, data.recipientId, 'cross_server');

    // Send delivery receipt back to sender's server
    await withRedisCircuit(async () => {
      await redisPub.publish(
        KEYS.serverChannel(data.senderServer!),
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

/**
 * Handles forwarding typing indicators, receipts, and reactions.
 */
function handleForwardMessage(data: RedisMessageData): void {
  const socket = getConnection(data.recipientId);
  if (socket) {
    sendToSocket(socket, data.payload);
  }
}
