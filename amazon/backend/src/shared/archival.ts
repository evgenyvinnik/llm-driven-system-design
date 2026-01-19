/**
 * Order Retention and Archival Configuration
 *
 * Manages order data lifecycle:
 * - Active orders in PostgreSQL (hot storage)
 * - Archived orders after retention period
 * - Data anonymization for compliance
 * - Cold storage for long-term retention
 *
 * Balances:
 * - Customer access to order history
 * - Legal retention requirements (7 years typical)
 * - Storage costs
 * - Query performance
 */
import { query, transaction } from '../services/database.js';
import logger from './logger.js';

// ============================================================
// Configuration
// ============================================================

/**
 * Retention policies by data type
 * All durations in days
 */
export const RetentionPolicies = {
  // Orders - keep in hot storage for 2 years, archive for 7 years total
  ORDERS: {
    hotStorageDays: 730,        // 2 years - quick access for customer support
    archiveRetentionDays: 2555, // 7 years total (legal requirement)
    anonymizeAfterDays: 2555    // Anonymize PII after 7 years
  },

  // Cart items - expire after 30 minutes
  CART_ITEMS: {
    reservationMinutes: 30,
    cleanupIntervalMinutes: 5
  },

  // Sessions - 24 hour TTL
  SESSIONS: {
    ttlSeconds: 86400
  },

  // Audit logs - keep for 3 years
  AUDIT_LOGS: {
    hotStorageDays: 365,        // 1 year in database
    archiveRetentionDays: 1095  // 3 years total
  },

  // Search logs - 90 days
  SEARCH_LOGS: {
    retentionDays: 90
  },

  // Idempotency keys - 24 hours
  IDEMPOTENCY_KEYS: {
    ttlSeconds: 86400
  },

  // Product recommendations cache - refresh daily
  RECOMMENDATIONS: {
    ttlSeconds: 86400
  }
};

/**
 * Order archive status enum
 */
export const ArchiveStatus = {
  ACTIVE: 'active',
  PENDING_ARCHIVE: 'pending_archive',
  ARCHIVED: 'archived',
  ANONYMIZED: 'anonymized'
};

// ============================================================
// Archival Functions
// ============================================================

/**
 * Get orders eligible for archival
 * @param {number} limit - Maximum number of orders to return
 * @returns {Promise<Object[]>} Orders to archive
 */
export async function getOrdersForArchival(limit = 1000) {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - RetentionPolicies.ORDERS.hotStorageDays);

  const result = await query(
    `SELECT o.id, o.user_id, o.created_at, o.status
     FROM orders o
     WHERE o.created_at < $1
       AND (o.archive_status IS NULL OR o.archive_status = 'active')
       AND o.status IN ('delivered', 'cancelled', 'refunded')
     ORDER BY o.created_at ASC
     LIMIT $2`,
    [cutoffDate, limit]
  );

  return result.rows;
}

/**
 * Archive a batch of orders
 * Moves data to cold storage and marks as archived
 * @param {number[]} orderIds - Order IDs to archive
 * @returns {Promise<Object>} Archive results
 */
export async function archiveOrders(orderIds) {
  if (orderIds.length === 0) {
    return { archived: 0, errors: [] };
  }

  let archived = 0;
  const errors = [];

  for (const orderId of orderIds) {
    try {
      await transaction(async (client) => {
        // Get full order data for archival
        const orderResult = await client.query(
          `SELECT o.*, json_agg(oi.*) as items
           FROM orders o
           LEFT JOIN order_items oi ON o.id = oi.order_id
           WHERE o.id = $1
           GROUP BY o.id`,
          [orderId]
        );

        if (orderResult.rows.length === 0) {
          throw new Error(`Order ${orderId} not found`);
        }

        const order = orderResult.rows[0];

        // Create archive record
        const archiveData = JSON.stringify({
          order: {
            id: order.id,
            userId: order.user_id,
            status: order.status,
            subtotal: order.subtotal,
            tax: order.tax,
            shippingCost: order.shipping_cost,
            total: order.total,
            paymentMethod: order.payment_method,
            paymentStatus: order.payment_status,
            notes: order.notes,
            createdAt: order.created_at,
            updatedAt: order.updated_at
          },
          items: order.items,
          archivedAt: new Date().toISOString()
        });

        // Store in orders_archive table
        await client.query(
          `INSERT INTO orders_archive (order_id, user_id, archive_data, created_at, archived_at)
           VALUES ($1, $2, $3, $4, NOW())`,
          [orderId, order.user_id, archiveData, order.created_at]
        );

        // Update order with archive status and remove PII
        await client.query(
          `UPDATE orders
           SET archive_status = 'archived',
               archived_at = NOW(),
               shipping_address = NULL,
               billing_address = NULL,
               notes = NULL
           WHERE id = $1`,
          [orderId]
        );

        archived++;
      });
    } catch (error) {
      logger.error({ orderId, error: error.message }, 'Failed to archive order');
      errors.push({ orderId, error: error.message });
    }
  }

  logger.info({ archived, errors: errors.length }, 'Order archival completed');
  return { archived, errors };
}

/**
 * Retrieve archived order data
 * For customer support or legal requests
 * @param {number} orderId - Order ID
 * @returns {Promise<Object|null>} Archived order data
 */
export async function retrieveArchivedOrder(orderId) {
  // First check if order is archived
  const orderCheck = await query(
    'SELECT id, archive_status FROM orders WHERE id = $1',
    [orderId]
  );

  if (orderCheck.rows.length === 0) {
    return null;
  }

  const order = orderCheck.rows[0];

  if (order.archive_status !== 'archived' && order.archive_status !== 'anonymized') {
    // Order is still in hot storage - return from main table
    const result = await query(
      `SELECT o.*, json_agg(oi.*) as items
       FROM orders o
       LEFT JOIN order_items oi ON o.id = oi.order_id
       WHERE o.id = $1
       GROUP BY o.id`,
      [orderId]
    );
    return result.rows[0];
  }

  // Retrieve from archive
  const archiveResult = await query(
    'SELECT * FROM orders_archive WHERE order_id = $1',
    [orderId]
  );

  if (archiveResult.rows.length === 0) {
    logger.warn({ orderId }, 'Archived order not found in archive table');
    return null;
  }

  return JSON.parse(archiveResult.rows[0].archive_data);
}

/**
 * Anonymize old orders for GDPR/CCPA compliance
 * @param {number} limit - Maximum orders to process
 * @returns {Promise<number>} Number of orders anonymized
 */
export async function anonymizeOldOrders(limit = 500) {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - RetentionPolicies.ORDERS.anonymizeAfterDays);

  const result = await query(
    `UPDATE orders
     SET shipping_address = '{"anonymized": true}'::jsonb,
         billing_address = '{"anonymized": true}'::jsonb,
         notes = NULL,
         archive_status = 'anonymized',
         updated_at = NOW()
     WHERE created_at < $1
       AND archive_status != 'anonymized'
     RETURNING id`,
    [cutoffDate]
  );

  const count = result.rowCount;
  if (count > 0) {
    logger.info({ count }, 'Anonymized old orders');
  }

  return count;
}

// ============================================================
// Cleanup Functions
// ============================================================

/**
 * Clean up expired cart reservations
 * @returns {Promise<number>} Number of cart items cleaned
 */
export async function cleanupExpiredCartItems() {
  const result = await query(
    `DELETE FROM cart_items
     WHERE reserved_until IS NOT NULL AND reserved_until < NOW()
     RETURNING product_id, quantity`
  );

  const count = result.rowCount;
  if (count > 0) {
    logger.info({ count }, 'Cleaned up expired cart reservations');

    // Release inventory reservations
    for (const item of result.rows) {
      await query(
        `UPDATE inventory SET reserved = GREATEST(0, reserved - $1)
         WHERE product_id = $2`,
        [item.quantity, item.product_id]
      );
    }
  }

  return count;
}

/**
 * Clean up old search logs
 * @returns {Promise<number>} Number of logs deleted
 */
export async function cleanupSearchLogs() {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - RetentionPolicies.SEARCH_LOGS.retentionDays);

  const result = await query(
    'DELETE FROM search_logs WHERE created_at < $1',
    [cutoffDate]
  );

  if (result.rowCount > 0) {
    logger.info({ count: result.rowCount }, 'Cleaned up old search logs');
  }

  return result.rowCount || 0;
}

/**
 * Clean up old audit logs (move to archive)
 * @returns {Promise<number>} Number of logs archived
 */
export async function archiveOldAuditLogs() {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - RetentionPolicies.AUDIT_LOGS.hotStorageDays);

  // For now, just log - in production would move to cold storage
  const countResult = await query(
    'SELECT COUNT(*) as count FROM audit_logs WHERE created_at < $1',
    [cutoffDate]
  );

  const count = parseInt(countResult.rows[0].count);
  if (count > 0) {
    logger.info({ count, cutoffDate }, 'Audit logs eligible for archival');
    // In production: Move to S3/MinIO cold storage
  }

  return count;
}

/**
 * Clean up expired idempotency keys
 * @returns {Promise<number>} Number of keys deleted
 */
export async function cleanupIdempotencyKeys() {
  const cutoffDate = new Date(Date.now() - RetentionPolicies.IDEMPOTENCY_KEYS.ttlSeconds * 1000);

  const result = await query(
    'DELETE FROM idempotency_keys WHERE created_at < $1',
    [cutoffDate]
  );

  if (result.rowCount > 0) {
    logger.info({ count: result.rowCount }, 'Cleaned up expired idempotency keys');
  }

  return result.rowCount || 0;
}

/**
 * Clean up expired sessions
 * @returns {Promise<number>} Number of sessions deleted
 */
export async function cleanupExpiredSessions() {
  const result = await query(
    'DELETE FROM sessions WHERE expires_at < NOW()'
  );

  if (result.rowCount > 0) {
    logger.info({ count: result.rowCount }, 'Cleaned up expired sessions');
  }

  return result.rowCount || 0;
}

// ============================================================
// Scheduled Job Runner
// ============================================================

/**
 * Run all archival and cleanup jobs
 * Should be called periodically (e.g., daily)
 */
export async function runArchivalJobs() {
  logger.info('Starting archival jobs');

  try {
    // Clean up expired data first
    await cleanupExpiredCartItems();
    await cleanupExpiredSessions();
    await cleanupIdempotencyKeys();
    await cleanupSearchLogs();

    // Archive old orders
    const ordersToArchive = await getOrdersForArchival(500);
    if (ordersToArchive.length > 0) {
      await archiveOrders(ordersToArchive.map(o => o.id));
    }

    // Anonymize very old orders
    await anonymizeOldOrders();

    // Archive old audit logs
    await archiveOldAuditLogs();

    logger.info('Archival jobs completed');
  } catch (error) {
    logger.error({ error: error.message }, 'Archival jobs failed');
  }
}

/**
 * Get data retention statistics
 * @returns {Promise<Object>} Retention stats
 */
export async function getRetentionStats() {
  const stats = {};

  // Orders by status
  const orderStats = await query(`
    SELECT
      COUNT(*) FILTER (WHERE archive_status IS NULL OR archive_status = 'active') as active_orders,
      COUNT(*) FILTER (WHERE archive_status = 'archived') as archived_orders,
      COUNT(*) FILTER (WHERE archive_status = 'anonymized') as anonymized_orders,
      MIN(created_at) FILTER (WHERE archive_status IS NULL OR archive_status = 'active') as oldest_active_order
    FROM orders
  `);
  stats.orders = orderStats.rows[0];

  // Cart items
  const cartStats = await query(`
    SELECT
      COUNT(*) as total_items,
      COUNT(*) FILTER (WHERE reserved_until < NOW()) as expired_items
    FROM cart_items
  `);
  stats.cartItems = cartStats.rows[0];

  // Audit logs
  const auditStats = await query(`
    SELECT
      COUNT(*) as total_logs,
      MIN(created_at) as oldest_log
    FROM audit_logs
  `);
  stats.auditLogs = auditStats.rows[0];

  // Sessions
  const sessionStats = await query(`
    SELECT
      COUNT(*) as total_sessions,
      COUNT(*) FILTER (WHERE expires_at < NOW()) as expired_sessions
    FROM sessions
  `);
  stats.sessions = sessionStats.rows[0];

  return stats;
}

export default {
  RetentionPolicies,
  ArchiveStatus,
  getOrdersForArchival,
  archiveOrders,
  retrieveArchivedOrder,
  anonymizeOldOrders,
  cleanupExpiredCartItems,
  cleanupSearchLogs,
  archiveOldAuditLogs,
  cleanupIdempotencyKeys,
  cleanupExpiredSessions,
  runArchivalJobs,
  getRetentionStats
};
