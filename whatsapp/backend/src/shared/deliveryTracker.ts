/**
 * Message delivery status tracking module.
 *
 * Provides idempotent status updates and tracking for message delivery states.
 * Supports the message lifecycle: sent -> delivered -> read.
 *
 * WHY delivery receipts require idempotent status updates:
 * - Network retries may send duplicate delivery confirmations
 * - Cross-server routing may result in race conditions
 * - Client reconnections trigger re-delivery of pending messages
 * - Status can only progress forward (sent->delivered->read, never backwards)
 * - Idempotent updates prevent inconsistent state from duplicates
 *
 * Implementation:
 * - Uses Redis for tracking delivery timestamps and state
 * - Database updates use conditional writes (only update if status <= new_status)
 * - Metrics track delivery success rates and latency
 */

import { redis, _KEYS } from '../redis.js';
import { pool } from '../db.js';
import { recordMessage, recordDeliveryDuration } from './metrics.js';
import { _logger, LogEvents, logEvent } from './logger.js';
import { withRetry } from './retry.js';

/**
 * Status progression order for idempotent updates.
 * Higher index = more progressed state.
 */
const _STATUS_ORDER: Record<string, number> = {
  sent: 0,
  delivered: 1,
  read: 2,
};

/**
 * Delivery tracking data stored in Redis for timing metrics.
 */
interface DeliveryTracking {
  messageId: string;
  senderId: string;
  sentAt: number; // Unix timestamp ms
  deliveredAt?: number;
  readAt?: number;
}

/**
 * Starts tracking a message for delivery metrics.
 * Called when a message is first sent.
 *
 * @param messageId - The message being tracked
 * @param senderId - The user who sent the message
 */
export async function startDeliveryTracking(
  messageId: string,
  senderId: string
): Promise<void> {
  const tracking: DeliveryTracking = {
    messageId,
    senderId,
    sentAt: Date.now(),
  };

  await redis.setex(
    `delivery:${messageId}`,
    3600, // 1 hour TTL - enough time for delivery tracking
    JSON.stringify(tracking)
  );

  recordMessage('sent', 'text');
}

/**
 * Records message delivery and calculates delivery latency.
 *
 * @param messageId - The message that was delivered
 * @param recipientId - The user who received the message
 * @param deliveryType - How the message was delivered
 */
export async function recordDelivery(
  messageId: string,
  recipientId: string,
  deliveryType: 'local' | 'cross_server' | 'pending'
): Promise<void> {
  const trackingData = await redis.get(`delivery:${messageId}`);

  if (trackingData) {
    const tracking: DeliveryTracking = JSON.parse(trackingData);
    const deliveredAt = Date.now();
    const durationSeconds = (deliveredAt - tracking.sentAt) / 1000;

    // Record delivery latency
    recordDeliveryDuration(durationSeconds, deliveryType);

    // Update tracking with delivery time
    tracking.deliveredAt = deliveredAt;
    await redis.setex(`delivery:${messageId}`, 3600, JSON.stringify(tracking));
  }

  recordMessage('delivered', 'text');

  logEvent(LogEvents.MESSAGE_DELIVERED, {
    message_id: messageId,
    recipient_id: recipientId,
    delivery_type: deliveryType,
  });
}

/**
 * Records message read status.
 *
 * @param messageId - The message that was read
 * @param readerId - The user who read the message
 */
export async function recordRead(messageId: string, readerId: string): Promise<void> {
  recordMessage('read', 'text');

  logEvent(LogEvents.MESSAGE_READ, {
    message_id: messageId,
    reader_id: readerId,
  });
}

/**
 * Idempotent status update for a message.
 * Only updates if the new status is more progressed than the current status.
 * Prevents race conditions and duplicate updates from corrupting state.
 *
 * @param messageId - The message to update
 * @param recipientId - The recipient whose status is being updated
 * @param newStatus - The new status to set
 * @returns Whether the update was applied (true) or skipped (false)
 */
export async function idempotentStatusUpdate(
  messageId: string,
  recipientId: string,
  newStatus: 'sent' | 'delivered' | 'read'
): Promise<boolean> {
  return withRetry(
    async () => {
      const client = await pool.connect();

      try {
        // Use conditional update - only update if status is less progressed
        // This ensures idempotency: duplicate updates are no-ops
        const result = await client.query(
          `UPDATE message_status
           SET status = $3,
               delivered_at = CASE
                 WHEN $3 IN ('delivered', 'read') AND delivered_at IS NULL THEN NOW()
                 ELSE delivered_at
               END,
               read_at = CASE
                 WHEN $3 = 'read' AND read_at IS NULL THEN NOW()
                 ELSE read_at
               END
           WHERE message_id = $1
             AND recipient_id = $2
             AND (
               CASE status
                 WHEN 'sent' THEN 0
                 WHEN 'delivered' THEN 1
                 WHEN 'read' THEN 2
               END
             ) < (
               CASE $3
                 WHEN 'sent' THEN 0
                 WHEN 'delivered' THEN 1
                 WHEN 'read' THEN 2
               END
             )
           RETURNING *`,
          [messageId, recipientId, newStatus]
        );

        const wasUpdated = (result.rowCount ?? 0) > 0;

        if (wasUpdated) {
          // Track the status change
          if (newStatus === 'delivered') {
            await recordDelivery(messageId, recipientId, 'local');
          } else if (newStatus === 'read') {
            await recordRead(messageId, recipientId);
          }
        }

        return wasUpdated;
      } finally {
        client.release();
      }
    },
    {
      operationName: 'status_update',
      maxRetries: 3,
    }
  );
}

/**
 * Batch status update for multiple messages.
 * Used when marking a conversation as read.
 *
 * @param messageIds - Array of message IDs to update
 * @param recipientId - The recipient marking messages as read
 * @param newStatus - The new status to set
 * @returns Array of message IDs that were actually updated
 */
export async function batchStatusUpdate(
  messageIds: string[],
  recipientId: string,
  newStatus: 'delivered' | 'read'
): Promise<string[]> {
  if (messageIds.length === 0) return [];

  return withRetry(
    async () => {
      const result = await pool.query(
        `UPDATE message_status
         SET status = $3,
             delivered_at = CASE
               WHEN $3 IN ('delivered', 'read') AND delivered_at IS NULL THEN NOW()
               ELSE delivered_at
             END,
             read_at = CASE
               WHEN $3 = 'read' AND read_at IS NULL THEN NOW()
               ELSE read_at
             END
         WHERE message_id = ANY($1)
           AND recipient_id = $2
           AND (
             CASE status
               WHEN 'sent' THEN 0
               WHEN 'delivered' THEN 1
               WHEN 'read' THEN 2
             END
           ) < (
             CASE $3
               WHEN 'sent' THEN 0
               WHEN 'delivered' THEN 1
               WHEN 'read' THEN 2
             END
           )
         RETURNING message_id`,
        [messageIds, recipientId, newStatus]
      );

      const updatedIds = result.rows.map((row: { message_id: string }) => row.message_id);

      // Record metrics for each updated message
      for (const _id of updatedIds) {
        if (newStatus === 'delivered') {
          recordMessage('delivered', 'text');
        } else if (newStatus === 'read') {
          recordMessage('read', 'text');
        }
      }

      return updatedIds;
    },
    {
      operationName: 'batch_status_update',
      maxRetries: 3,
    }
  );
}

/**
 * Gets the current delivery status for a message.
 *
 * @param messageId - The message to query
 * @returns Map of recipient ID to status
 */
export async function getDeliveryStatus(
  messageId: string
): Promise<Map<string, 'sent' | 'delivered' | 'read'>> {
  const result = await pool.query(
    'SELECT recipient_id, status FROM message_status WHERE message_id = $1',
    [messageId]
  );

  const statusMap = new Map<string, 'sent' | 'delivered' | 'read'>();
  for (const row of result.rows) {
    statusMap.set(row.recipient_id, row.status);
  }

  return statusMap;
}

/**
 * Gets aggregated delivery statistics for metrics.
 *
 * @returns Object with delivery stats
 */
export async function getDeliveryStats(): Promise<{
  totalSent: number;
  totalDelivered: number;
  totalRead: number;
  deliveryRate: number;
  readRate: number;
}> {
  const result = await pool.query(`
    SELECT
      COUNT(*) as total,
      COUNT(*) FILTER (WHERE status = 'sent') as sent,
      COUNT(*) FILTER (WHERE status = 'delivered') as delivered,
      COUNT(*) FILTER (WHERE status = 'read') as read
    FROM message_status
    WHERE created_at > NOW() - INTERVAL '24 hours'
  `);

  const stats = result.rows[0];
  const total = parseInt(stats.total) || 1; // Avoid division by zero

  return {
    totalSent: parseInt(stats.sent) || 0,
    totalDelivered: parseInt(stats.delivered) || 0,
    totalRead: parseInt(stats.read) || 0,
    deliveryRate: (parseInt(stats.delivered) + parseInt(stats.read)) / total,
    readRate: parseInt(stats.read) / total,
  };
}
