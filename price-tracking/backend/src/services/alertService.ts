import { query, queryOne } from '../db/pool.js';
import { publishAlert, cacheDelete } from '../db/redis.js';
import { Alert, UserProduct, Product } from '../types/index.js';
import logger, { logAlert } from '../utils/logger.js';
import { alertsTriggered, alertsSent } from '../shared/metrics.js';

/**
 * Represents a price change event to be processed for alert generation.
 * Used by the scraper worker when a product's price changes.
 */
export interface PriceChangeEvent {
  product_id: string;
  old_price: number | null;
  new_price: number;
  change_pct: number;
}

/**
 * Processes a price change event and creates alerts for subscribed users.
 * Checks each user's subscription settings (target price, notify on any drop)
 * and generates appropriate alerts. Alerts are persisted to the database
 * and published via Redis for real-time notification delivery.
 * @param event - The price change event containing old and new prices
 */
export async function processPriceChange(event: PriceChangeEvent): Promise<void> {
  const { product_id, old_price, new_price } = event;

  // Skip if no price change
  if (old_price !== null && old_price === new_price) {
    return;
  }

  // Get all subscriptions for this product
  const subscriptions = await query<UserProduct & { user_email: string }>(
    `SELECT up.*, u.email as user_email, u.email_notifications
     FROM user_products up
     JOIN users u ON up.user_id = u.id
     WHERE up.product_id = $1`,
    [product_id]
  );

  const alertsToCreate: Array<{
    user_id: string;
    product_id: string;
    alert_type: string;
    old_price: number | null;
    new_price: number;
  }> = [];

  for (const sub of subscriptions) {
    let shouldAlert = false;
    let alertType = '';

    // Check target price
    if (sub.target_price && new_price <= sub.target_price) {
      shouldAlert = true;
      alertType = 'target_reached';
    }
    // Check any drop
    else if (sub.notify_any_drop && old_price && new_price < old_price) {
      shouldAlert = true;
      alertType = 'price_drop';
    }

    if (shouldAlert) {
      alertsToCreate.push({
        user_id: sub.user_id,
        product_id,
        alert_type: alertType,
        old_price,
        new_price,
      });
    }
  }

  // Batch create alerts
  if (alertsToCreate.length > 0) {
    await createAlerts(alertsToCreate);
    logger.info(
      {
        action: 'alerts_created',
        count: alertsToCreate.length,
        productId: product_id,
        alertTypes: alertsToCreate.map(a => a.alert_type),
      },
      `Created ${alertsToCreate.length} alerts for product ${product_id}`
    );
  }
}

/**
 * Creates alert records in the database and publishes to Redis.
 * Batch processes multiple alerts for efficiency.
 * Invalidates user alert caches to ensure fresh data on next read.
 * @param alerts - Array of alert objects to create
 */
async function createAlerts(
  alerts: Array<{
    user_id: string;
    product_id: string;
    alert_type: string;
    old_price: number | null;
    new_price: number;
  }>
): Promise<void> {
  for (const alert of alerts) {
    const created = await queryOne<Alert>(
      `INSERT INTO alerts (user_id, product_id, alert_type, old_price, new_price)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [alert.user_id, alert.product_id, alert.alert_type, alert.old_price, alert.new_price]
    );

    if (created) {
      // Track alert metric
      alertsTriggered.labels(alert.alert_type).inc();

      // Log the alert with structured data
      logAlert(alert.user_id, alert.product_id, alert.alert_type, alert.old_price, alert.new_price);

      // Publish for real-time notification
      await publishAlert({
        userId: alert.user_id,
        productId: alert.product_id,
        type: alert.alert_type,
        newPrice: alert.new_price,
      });

      // Track sent metric
      alertsSent.labels('pubsub', 'success').inc();

      // Invalidate user alerts cache
      await cacheDelete(`user:${alert.user_id}:alerts`);
    }
  }
}

/**
 * Retrieves a user's alerts with associated product information.
 * Supports filtering to show only unread alerts.
 * @param userId - The user ID
 * @param unreadOnly - If true, only returns unread alerts
 * @param limit - Maximum number of alerts to return (default: 50)
 * @returns Array of alerts with embedded product objects
 */
export async function getUserAlerts(
  userId: string,
  unreadOnly: boolean = false,
  limit: number = 50
): Promise<(Alert & { product: Product })[]> {
  let sql = `
    SELECT a.*,
           row_to_json(p.*) as product
    FROM alerts a
    JOIN products p ON a.product_id = p.id
    WHERE a.user_id = $1
  `;

  if (unreadOnly) {
    sql += ' AND a.is_read = false';
  }

  sql += ' ORDER BY a.created_at DESC LIMIT $2';

  const result = await query<Alert & { product: string }>(sql, [userId, limit]);

  return result.map((row) => ({
    ...row,
    product: JSON.parse(row.product as unknown as string) as Product,
  }));
}

/**
 * Marks a single alert as read.
 * Invalidates the user's alert cache.
 * @param alertId - The alert ID to mark as read
 * @param userId - The user ID (for authorization)
 * @returns The updated alert or null if not found/unauthorized
 */
export async function markAlertAsRead(alertId: string, userId: string): Promise<Alert | null> {
  const result = await query<Alert>(
    `UPDATE alerts
     SET is_read = true
     WHERE id = $1 AND user_id = $2
     RETURNING *`,
    [alertId, userId]
  );

  if (result.length > 0) {
    await cacheDelete(`user:${userId}:alerts`);
    return result[0];
  }
  return null;
}

/**
 * Marks all of a user's alerts as read.
 * Used for "mark all as read" functionality.
 * @param userId - The user ID
 * @returns The number of alerts marked as read
 */
export async function markAllAlertsAsRead(userId: string): Promise<number> {
  const result = await query<{ id: string }>(
    `UPDATE alerts
     SET is_read = true
     WHERE user_id = $1 AND is_read = false
     RETURNING id`,
    [userId]
  );

  await cacheDelete(`user:${userId}:alerts`);
  return result.length;
}

/**
 * Gets the count of unread alerts for a user.
 * Used for badge display in the navigation header.
 * @param userId - The user ID
 * @returns Number of unread alerts
 */
export async function getUnreadAlertCount(userId: string): Promise<number> {
  const result = await queryOne<{ count: number }>(
    'SELECT COUNT(*)::integer as count FROM alerts WHERE user_id = $1 AND is_read = false',
    [userId]
  );
  return result?.count || 0;
}

/**
 * Permanently deletes an alert.
 * @param alertId - The alert ID to delete
 * @param userId - The user ID (for authorization)
 * @returns True if deleted, false if not found/unauthorized
 */
export async function deleteAlert(alertId: string, userId: string): Promise<boolean> {
  const result = await query<{ id: string }>(
    'DELETE FROM alerts WHERE id = $1 AND user_id = $2 RETURNING id',
    [alertId, userId]
  );

  if (result.length > 0) {
    await cacheDelete(`user:${userId}:alerts`);
    return true;
  }
  return false;
}
