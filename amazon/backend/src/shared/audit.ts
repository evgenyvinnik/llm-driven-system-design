/**
 * Audit Logging for Order and Payment Operations
 *
 * Provides tamper-evident audit trail for:
 * - Order lifecycle (creation, cancellation, refunds)
 * - Payment transactions
 * - Inventory adjustments
 * - Admin actions
 *
 * Essential for:
 * - Order dispute resolution
 * - Fraud investigation
 * - Regulatory compliance
 * - System debugging
 */
import { query } from '../services/database.js';
import logger from './logger.js';
import { auditEventsTotal } from './metrics.js';

// Audit event types
export const AuditEventTypes = {
  // Order lifecycle
  ORDER_CREATED: 'order.created',
  ORDER_CONFIRMED: 'order.confirmed',
  ORDER_PROCESSING: 'order.processing',
  ORDER_SHIPPED: 'order.shipped',
  ORDER_DELIVERED: 'order.delivered',
  ORDER_CANCELLED: 'order.cancelled',
  ORDER_REFUNDED: 'order.refunded',
  ORDER_STATUS_CHANGED: 'order.status_changed',

  // Payment events
  PAYMENT_INITIATED: 'payment.initiated',
  PAYMENT_COMPLETED: 'payment.completed',
  PAYMENT_FAILED: 'payment.failed',
  PAYMENT_REFUND_INITIATED: 'payment.refund_initiated',
  PAYMENT_REFUND_COMPLETED: 'payment.refund_completed',

  // Inventory events
  INVENTORY_RESERVED: 'inventory.reserved',
  INVENTORY_RELEASED: 'inventory.released',
  INVENTORY_ADJUSTED: 'inventory.adjusted',
  INVENTORY_DEPLETED: 'inventory.depleted',

  // Cart events
  CART_CHECKOUT_STARTED: 'cart.checkout_started',
  CART_ABANDONED: 'cart.abandoned',

  // Admin actions
  ADMIN_ORDER_UPDATE: 'admin.order_update',
  ADMIN_REFUND: 'admin.refund',
  ADMIN_INVENTORY_OVERRIDE: 'admin.inventory_override',
  ADMIN_USER_SUSPEND: 'admin.user_suspend',

  // Security events
  AUTH_LOGIN: 'auth.login',
  AUTH_LOGOUT: 'auth.logout',
  AUTH_FAILED: 'auth.failed',
  AUTH_PASSWORD_CHANGE: 'auth.password_change'
};

// Severity levels for audit events
export const AuditSeverity = {
  INFO: 'info',
  WARNING: 'warning',
  CRITICAL: 'critical'
};

// Actor types
export const ActorType = {
  USER: 'user',
  ADMIN: 'admin',
  SYSTEM: 'system',
  SERVICE: 'service'
};

/**
 * Audit log entry structure
 * @typedef {Object} AuditEntry
 * @property {string} action - Event type from AuditEventTypes
 * @property {Object} actor - Who performed the action
 * @property {Object} resource - What was affected
 * @property {Object} changes - What changed (old/new values)
 * @property {Object} context - Additional context (IP, user agent, correlation ID)
 * @property {string} severity - Event severity
 */

/**
 * Create an audit log entry
 * @param {Object} entry - Audit entry data
 * @returns {Promise<number>} Audit log ID
 */
export async function createAuditLog(entry) {
  const {
    action,
    actor,
    resource,
    changes = {},
    context = {},
    severity = AuditSeverity.INFO
  } = entry;

  try {
    // Log to structured logger
    logger.info({
      type: 'audit',
      action,
      actor,
      resource,
      changes,
      severity,
      correlationId: context.correlationId
    }, `Audit: ${action}`);

    // Store in database
    const result = await query(
      `INSERT INTO audit_logs
       (action, actor_id, actor_type, resource_type, resource_id, old_value, new_value, ip_address, user_agent, correlation_id, severity)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id`,
      [
        action,
        actor.id,
        actor.type,
        resource.type,
        resource.id?.toString(),
        changes.old ? JSON.stringify(changes.old) : null,
        changes.new ? JSON.stringify(changes.new) : null,
        context.ip,
        context.userAgent,
        context.correlationId,
        severity
      ]
    );

    // Update metrics
    auditEventsTotal.inc({ action, resource_type: resource.type });

    return result.rows[0].id;
  } catch (error) {
    // Audit logging should never break the main flow
    logger.error({ error: error.message, action, resource }, 'Failed to create audit log');
    return null;
  }
}

/**
 * Create audit context from Express request
 * @param {Object} req - Express request object
 * @returns {Object} Audit context
 */
export function createAuditContext(req) {
  return {
    ip: req.ip || req.headers['x-forwarded-for'] || req.connection?.remoteAddress,
    userAgent: req.headers['user-agent'],
    correlationId: req.correlationId || req.headers['x-correlation-id']
  };
}

/**
 * Create actor object from request
 * @param {Object} req - Express request object
 * @returns {Object} Actor object
 */
export function createActor(req) {
  if (req.user) {
    return {
      id: req.user.id,
      type: req.user.role === 'admin' ? ActorType.ADMIN : ActorType.USER,
      email: req.user.email
    };
  }

  return {
    id: null,
    type: ActorType.SYSTEM
  };
}

// ============================================================
// Convenience Functions for Common Audit Events
// ============================================================

/**
 * Audit order creation
 * @param {Object} req - Express request
 * @param {Object} order - Created order
 * @param {Object} cartItems - Items that were in cart
 */
export async function auditOrderCreated(req, order, cartItems = []) {
  await createAuditLog({
    action: AuditEventTypes.ORDER_CREATED,
    actor: createActor(req),
    resource: { type: 'order', id: order.id },
    changes: {
      new: {
        orderId: order.id,
        total: order.total,
        itemCount: cartItems.length,
        items: cartItems.map(i => ({ productId: i.product_id, quantity: i.quantity })),
        paymentMethod: order.payment_method
      }
    },
    context: createAuditContext(req),
    severity: AuditSeverity.INFO
  });
}

/**
 * Audit order cancellation
 * @param {Object} req - Express request
 * @param {Object} order - Cancelled order
 * @param {string} reason - Cancellation reason
 */
export async function auditOrderCancelled(req, order, reason = '') {
  await createAuditLog({
    action: AuditEventTypes.ORDER_CANCELLED,
    actor: createActor(req),
    resource: { type: 'order', id: order.id },
    changes: {
      old: { status: order.status },
      new: { status: 'cancelled', reason }
    },
    context: createAuditContext(req),
    severity: AuditSeverity.WARNING
  });
}

/**
 * Audit order status change
 * @param {Object} req - Express request
 * @param {number} orderId - Order ID
 * @param {string} oldStatus - Previous status
 * @param {string} newStatus - New status
 */
export async function auditOrderStatusChanged(req, orderId, oldStatus, newStatus) {
  await createAuditLog({
    action: AuditEventTypes.ORDER_STATUS_CHANGED,
    actor: createActor(req),
    resource: { type: 'order', id: orderId },
    changes: {
      old: { status: oldStatus },
      new: { status: newStatus }
    },
    context: createAuditContext(req),
    severity: AuditSeverity.INFO
  });
}

/**
 * Audit order refund
 * @param {Object} req - Express request
 * @param {Object} order - Refunded order
 * @param {number} amount - Refund amount
 * @param {string} reason - Refund reason
 */
export async function auditOrderRefunded(req, order, amount, reason = '') {
  await createAuditLog({
    action: AuditEventTypes.ORDER_REFUNDED,
    actor: createActor(req),
    resource: { type: 'order', id: order.id },
    changes: {
      old: { paymentStatus: order.payment_status },
      new: { paymentStatus: 'refunded', refundAmount: amount, reason }
    },
    context: createAuditContext(req),
    severity: AuditSeverity.CRITICAL
  });
}

/**
 * Audit payment completion
 * @param {Object} req - Express request
 * @param {number} orderId - Order ID
 * @param {Object} paymentDetails - Payment transaction details
 */
export async function auditPaymentCompleted(req, orderId, paymentDetails) {
  await createAuditLog({
    action: AuditEventTypes.PAYMENT_COMPLETED,
    actor: createActor(req),
    resource: { type: 'order', id: orderId },
    changes: {
      new: {
        transactionId: paymentDetails.transactionId,
        amount: paymentDetails.amount,
        method: paymentDetails.method,
        // Mask sensitive data
        lastFour: paymentDetails.lastFour
      }
    },
    context: createAuditContext(req),
    severity: AuditSeverity.INFO
  });
}

/**
 * Audit payment failure
 * @param {Object} req - Express request
 * @param {number} orderId - Order ID
 * @param {string} errorCode - Payment error code
 * @param {string} errorMessage - Payment error message
 */
export async function auditPaymentFailed(req, orderId, errorCode, errorMessage) {
  await createAuditLog({
    action: AuditEventTypes.PAYMENT_FAILED,
    actor: createActor(req),
    resource: { type: 'order', id: orderId },
    changes: {
      new: {
        errorCode,
        errorMessage
      }
    },
    context: createAuditContext(req),
    severity: AuditSeverity.WARNING
  });
}

/**
 * Audit inventory reservation
 * @param {Object} req - Express request
 * @param {number} productId - Product ID
 * @param {number} quantity - Quantity reserved
 * @param {string} reason - Reason for reservation
 */
export async function auditInventoryReserved(req, productId, quantity, reason = 'cart') {
  await createAuditLog({
    action: AuditEventTypes.INVENTORY_RESERVED,
    actor: createActor(req),
    resource: { type: 'inventory', id: productId },
    changes: {
      new: { quantity, reason }
    },
    context: createAuditContext(req),
    severity: AuditSeverity.INFO
  });
}

/**
 * Audit inventory release
 * @param {Object} req - Express request or null for system
 * @param {number} productId - Product ID
 * @param {number} quantity - Quantity released
 * @param {string} reason - Reason for release
 */
export async function auditInventoryReleased(req, productId, quantity, reason = 'expiry') {
  const actor = req
    ? createActor(req)
    : { id: null, type: ActorType.SYSTEM };

  await createAuditLog({
    action: AuditEventTypes.INVENTORY_RELEASED,
    actor,
    resource: { type: 'inventory', id: productId },
    changes: {
      new: { quantity, reason }
    },
    context: req ? createAuditContext(req) : {},
    severity: AuditSeverity.INFO
  });
}

/**
 * Audit admin action
 * @param {Object} req - Express request
 * @param {string} action - Admin action type
 * @param {Object} resource - Affected resource
 * @param {Object} changes - Changes made
 */
export async function auditAdminAction(req, action, resource, changes) {
  await createAuditLog({
    action,
    actor: createActor(req),
    resource,
    changes,
    context: createAuditContext(req),
    severity: AuditSeverity.CRITICAL
  });
}

/**
 * Query audit logs with filters
 * @param {Object} filters - Query filters
 * @returns {Promise<Object>} Paginated audit logs
 */
export async function queryAuditLogs(filters = {}) {
  const {
    action,
    actorId,
    actorType,
    resourceType,
    resourceId,
    startDate,
    endDate,
    severity,
    page = 0,
    limit = 50
  } = filters;

  let whereClause = 'WHERE 1=1';
  const params = [];

  if (action) {
    params.push(action);
    whereClause += ` AND action = $${params.length}`;
  }

  if (actorId) {
    params.push(actorId);
    whereClause += ` AND actor_id = $${params.length}`;
  }

  if (actorType) {
    params.push(actorType);
    whereClause += ` AND actor_type = $${params.length}`;
  }

  if (resourceType) {
    params.push(resourceType);
    whereClause += ` AND resource_type = $${params.length}`;
  }

  if (resourceId) {
    params.push(resourceId.toString());
    whereClause += ` AND resource_id = $${params.length}`;
  }

  if (startDate) {
    params.push(startDate);
    whereClause += ` AND created_at >= $${params.length}`;
  }

  if (endDate) {
    params.push(endDate);
    whereClause += ` AND created_at <= $${params.length}`;
  }

  if (severity) {
    params.push(severity);
    whereClause += ` AND severity = $${params.length}`;
  }

  const offset = page * limit;

  const result = await query(
    `SELECT * FROM audit_logs ${whereClause}
     ORDER BY created_at DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset]
  );

  const countResult = await query(
    `SELECT COUNT(*) as total FROM audit_logs ${whereClause}`,
    params
  );

  return {
    logs: result.rows,
    total: parseInt(countResult.rows[0].total),
    page,
    limit
  };
}

/**
 * Get audit trail for a specific order
 * Useful for dispute resolution
 * @param {number} orderId - Order ID
 * @returns {Promise<Object[]>} Audit trail
 */
export async function getOrderAuditTrail(orderId) {
  const result = await query(
    `SELECT * FROM audit_logs
     WHERE resource_type = 'order' AND resource_id = $1
     ORDER BY created_at ASC`,
    [orderId.toString()]
  );

  return result.rows;
}

export default {
  createAuditLog,
  createAuditContext,
  createActor,
  auditOrderCreated,
  auditOrderCancelled,
  auditOrderStatusChanged,
  auditOrderRefunded,
  auditPaymentCompleted,
  auditPaymentFailed,
  auditInventoryReserved,
  auditInventoryReleased,
  auditAdminAction,
  queryAuditLogs,
  getOrderAuditTrail,
  AuditEventTypes,
  AuditSeverity,
  ActorType
};
