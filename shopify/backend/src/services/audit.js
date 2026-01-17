import { query } from './db.js';
import logger from './logger.js';

/**
 * Audit logging service for tracking important business events
 *
 * WHY AUDIT LOGGING MATTERS:
 * 1. Order dispute resolution - track what happened during checkout
 * 2. Inventory discrepancy investigation - trace all quantity changes
 * 3. Compliance and security - who accessed what, when
 * 4. Debugging production issues - reconstruct event sequences
 */

// Actor types
export const ActorType = {
  CUSTOMER: 'customer',
  MERCHANT: 'merchant',
  ADMIN: 'admin',
  SYSTEM: 'system',
};

// Audit actions
export const AuditAction = {
  // Orders
  ORDER_CREATED: 'order.created',
  ORDER_UPDATED: 'order.updated',
  ORDER_CANCELLED: 'order.cancelled',
  ORDER_REFUNDED: 'order.refunded',
  ORDER_FULFILLED: 'order.fulfilled',

  // Inventory
  INVENTORY_ADJUSTED: 'inventory.adjusted',
  INVENTORY_RESERVED: 'inventory.reserved',
  INVENTORY_RELEASED: 'inventory.released',
  INVENTORY_COMMITTED: 'inventory.committed',

  // Products
  PRODUCT_CREATED: 'product.created',
  PRODUCT_UPDATED: 'product.updated',
  PRODUCT_DELETED: 'product.deleted',
  VARIANT_CREATED: 'variant.created',
  VARIANT_UPDATED: 'variant.updated',
  VARIANT_DELETED: 'variant.deleted',

  // Checkout
  CHECKOUT_STARTED: 'checkout.started',
  CHECKOUT_COMPLETED: 'checkout.completed',
  CHECKOUT_FAILED: 'checkout.failed',
  PAYMENT_PROCESSED: 'payment.processed',
  PAYMENT_FAILED: 'payment.failed',

  // Settings
  SETTINGS_UPDATED: 'settings.updated',
  DOMAIN_VERIFIED: 'domain.verified',
  DOMAIN_REMOVED: 'domain.removed',

  // Auth
  API_KEY_CREATED: 'api_key.created',
  API_KEY_REVOKED: 'api_key.revoked',
};

/**
 * Create an audit log entry
 * @param {object} context - Actor context
 * @param {string} action - Action performed
 * @param {object} resource - Resource affected
 * @param {object} changes - Before/after state
 */
export async function createAuditLog(context, action, resource, changes = {}) {
  try {
    await query(
      `INSERT INTO audit_logs (
        store_id, actor_id, actor_type, action,
        resource_type, resource_id, changes,
        ip_address, user_agent, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())`,
      [
        context.storeId,
        context.userId || null,
        context.userType || ActorType.SYSTEM,
        action,
        resource.type,
        resource.id,
        JSON.stringify(changes),
        context.ip || null,
        context.userAgent || null,
      ]
    );

    // Also log to structured logger for real-time analysis
    logger.info({
      audit: true,
      storeId: context.storeId,
      actorId: context.userId,
      actorType: context.userType,
      action,
      resourceType: resource.type,
      resourceId: resource.id,
      changes,
    }, `AUDIT: ${action}`);
  } catch (error) {
    // Audit logging failures should not break the main operation
    logger.error({ err: error, action, resource }, 'Failed to create audit log');
  }
}

/**
 * Log inventory change
 * @param {object} context - Actor context
 * @param {number} variantId - Variant ID
 * @param {number} oldQuantity - Previous quantity
 * @param {number} newQuantity - New quantity
 * @param {string} reason - Reason for change
 */
export async function logInventoryChange(context, variantId, oldQuantity, newQuantity, reason = null) {
  await createAuditLog(
    context,
    AuditAction.INVENTORY_ADJUSTED,
    { type: 'variant', id: variantId },
    {
      before: { inventory_quantity: oldQuantity },
      after: { inventory_quantity: newQuantity },
      delta: newQuantity - oldQuantity,
      reason,
    }
  );
}

/**
 * Log order creation
 * @param {object} context - Actor context
 * @param {object} order - Order data
 */
export async function logOrderCreated(context, order) {
  await createAuditLog(
    context,
    AuditAction.ORDER_CREATED,
    { type: 'order', id: order.id },
    {
      after: {
        orderNumber: order.order_number,
        total: order.total,
        itemCount: order.items?.length || 0,
        customerEmail: order.customer_email,
      },
    }
  );
}

/**
 * Log order status change
 * @param {object} context - Actor context
 * @param {number} orderId - Order ID
 * @param {object} before - Previous state
 * @param {object} after - New state
 */
export async function logOrderUpdated(context, orderId, before, after) {
  await createAuditLog(
    context,
    AuditAction.ORDER_UPDATED,
    { type: 'order', id: orderId },
    { before, after }
  );
}

/**
 * Log checkout event
 * @param {object} context - Actor context
 * @param {string} action - Checkout action
 * @param {object} details - Event details
 */
export async function logCheckoutEvent(context, action, details) {
  await createAuditLog(
    context,
    action,
    { type: 'checkout', id: details.cartId || details.orderId },
    { details }
  );
}

/**
 * Log payment event
 * @param {object} context - Actor context
 * @param {boolean} success - Whether payment succeeded
 * @param {object} paymentDetails - Payment details
 */
export async function logPaymentEvent(context, success, paymentDetails) {
  await createAuditLog(
    context,
    success ? AuditAction.PAYMENT_PROCESSED : AuditAction.PAYMENT_FAILED,
    { type: 'payment', id: paymentDetails.paymentIntentId || null },
    {
      success,
      amount: paymentDetails.amount,
      orderId: paymentDetails.orderId,
      error: paymentDetails.error || null,
    }
  );
}

/**
 * Query audit logs for a resource
 * @param {number} storeId - Store ID
 * @param {string} resourceType - Resource type
 * @param {number} resourceId - Resource ID
 * @returns {Array} Audit log entries
 */
export async function getAuditLogsForResource(storeId, resourceType, resourceId) {
  const result = await query(
    `SELECT * FROM audit_logs
     WHERE store_id = $1 AND resource_type = $2 AND resource_id = $3
     ORDER BY created_at DESC
     LIMIT 100`,
    [storeId, resourceType, resourceId]
  );
  return result.rows;
}

/**
 * Query audit logs by action
 * @param {number} storeId - Store ID
 * @param {string} action - Action to filter by
 * @param {number} limit - Maximum results
 * @returns {Array} Audit log entries
 */
export async function getAuditLogsByAction(storeId, action, limit = 100) {
  const result = await query(
    `SELECT * FROM audit_logs
     WHERE store_id = $1 AND action = $2
     ORDER BY created_at DESC
     LIMIT $3`,
    [storeId, action, limit]
  );
  return result.rows;
}

/**
 * Query audit logs by actor
 * @param {number} storeId - Store ID
 * @param {number} actorId - Actor ID
 * @param {number} limit - Maximum results
 * @returns {Array} Audit log entries
 */
export async function getAuditLogsByActor(storeId, actorId, limit = 100) {
  const result = await query(
    `SELECT * FROM audit_logs
     WHERE store_id = $1 AND actor_id = $2
     ORDER BY created_at DESC
     LIMIT $3`,
    [storeId, actorId, limit]
  );
  return result.rows;
}

/**
 * Get audit trail for an order (dispute resolution)
 * @param {number} storeId - Store ID
 * @param {number} orderId - Order ID
 * @returns {Array} Complete audit trail
 */
export async function getOrderAuditTrail(storeId, orderId) {
  const result = await query(
    `SELECT * FROM audit_logs
     WHERE store_id = $1
       AND (
         (resource_type = 'order' AND resource_id = $2)
         OR (resource_type = 'checkout' AND (changes->>'orderId')::int = $2)
         OR (resource_type = 'payment' AND (changes->>'orderId')::int = $2)
       )
     ORDER BY created_at ASC`,
    [storeId, orderId]
  );
  return result.rows;
}

/**
 * Express middleware to extract audit context from request
 */
export function auditContextMiddleware(req, res, next) {
  req.auditContext = {
    storeId: req.storeId || null,
    userId: req.user?.id || null,
    userType: req.user?.role || ActorType.SYSTEM,
    ip: req.ip || req.connection?.remoteAddress,
    userAgent: req.headers['user-agent'],
  };
  next();
}

export default {
  ActorType,
  AuditAction,
  createAuditLog,
  logInventoryChange,
  logOrderCreated,
  logOrderUpdated,
  logCheckoutEvent,
  logPaymentEvent,
  getAuditLogsForResource,
  getAuditLogsByAction,
  getAuditLogsByActor,
  getOrderAuditTrail,
  auditContextMiddleware,
};
