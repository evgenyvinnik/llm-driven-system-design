import { query } from '../db.js';
import logger from './logger.js';

/**
 * Audit event types
 */
export const AUDIT_EVENTS = {
  // Order events
  ORDER_CREATED: 'ORDER_CREATED',
  ORDER_STATUS_CHANGED: 'ORDER_STATUS_CHANGED',
  ORDER_CANCELLED: 'ORDER_CANCELLED',
  ORDER_REFUNDED: 'ORDER_REFUNDED',

  // Driver events
  DRIVER_ASSIGNED: 'DRIVER_ASSIGNED',
  DRIVER_UNASSIGNED: 'DRIVER_UNASSIGNED',

  // Payment events
  PAYMENT_PROCESSED: 'PAYMENT_PROCESSED',
  PAYMENT_FAILED: 'PAYMENT_FAILED',

  // Menu events
  MENU_ITEM_CREATED: 'MENU_ITEM_CREATED',
  MENU_ITEM_UPDATED: 'MENU_ITEM_UPDATED',
  MENU_ITEM_DELETED: 'MENU_ITEM_DELETED',

  // Restaurant events
  RESTAURANT_UPDATED: 'RESTAURANT_UPDATED',
};

/**
 * Actor types for audit logs
 */
export const ACTOR_TYPES = {
  CUSTOMER: 'customer',
  DRIVER: 'driver',
  RESTAURANT: 'restaurant',
  ADMIN: 'admin',
  SYSTEM: 'system',
};

/**
 * Create an audit log entry
 * @param {Object} event - Audit event data
 * @param {string} event.eventType - Type of event (from AUDIT_EVENTS)
 * @param {string} event.entityType - Type of entity ('order', 'driver', etc.)
 * @param {number} event.entityId - ID of the entity
 * @param {string} event.actorType - Type of actor (from ACTOR_TYPES)
 * @param {number|null} event.actorId - ID of the actor (null for system)
 * @param {Object} event.changes - Before and after state
 * @param {Object} event.metadata - Additional context (IP, user agent, etc.)
 */
export async function createAuditLog(event) {
  try {
    const {
      eventType,
      entityType,
      entityId,
      actorType,
      actorId = null,
      changes = null,
      metadata = {},
    } = event;

    await query(
      `INSERT INTO audit_logs (
        event_type, entity_type, entity_id,
        actor_type, actor_id, changes, metadata
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        eventType,
        entityType,
        entityId,
        actorType,
        actorId,
        changes ? JSON.stringify(changes) : null,
        JSON.stringify(metadata),
      ]
    );

    logger.debug({
      eventType,
      entityType,
      entityId,
      actorType,
      actorId,
    }, 'Audit log created');
  } catch (error) {
    // Log error but don't throw - audit logging shouldn't break the main flow
    logger.error({
      error: error.message,
      event,
    }, 'Failed to create audit log');
  }
}

/**
 * Audit log for order status change
 * @param {Object} order - Order data
 * @param {string} fromStatus - Previous status
 * @param {string} toStatus - New status
 * @param {Object} actor - Actor information
 * @param {Object} metadata - Additional metadata (IP, user agent)
 */
export async function auditOrderStatusChange(order, fromStatus, toStatus, actor, metadata = {}) {
  await createAuditLog({
    eventType: toStatus === 'CANCELLED' ? AUDIT_EVENTS.ORDER_CANCELLED : AUDIT_EVENTS.ORDER_STATUS_CHANGED,
    entityType: 'order',
    entityId: order.id,
    actorType: actor.type,
    actorId: actor.id,
    changes: {
      before: { status: fromStatus },
      after: { status: toStatus },
    },
    metadata: {
      ...metadata,
      orderId: order.id,
      customerId: order.customer_id,
      restaurantId: order.restaurant_id,
      driverId: order.driver_id,
    },
  });
}

/**
 * Audit log for order creation
 * @param {Object} order - Created order data
 * @param {Object} actor - Actor information
 * @param {Object} metadata - Additional metadata
 */
export async function auditOrderCreated(order, actor, metadata = {}) {
  await createAuditLog({
    eventType: AUDIT_EVENTS.ORDER_CREATED,
    entityType: 'order',
    entityId: order.id,
    actorType: actor.type,
    actorId: actor.id,
    changes: {
      before: null,
      after: {
        status: order.status,
        total: order.total,
        restaurantId: order.restaurant_id,
      },
    },
    metadata: {
      ...metadata,
      itemCount: order.items?.length || 0,
    },
  });
}

/**
 * Audit log for driver assignment
 * @param {number} orderId - Order ID
 * @param {number} driverId - Driver ID
 * @param {Object} metadata - Additional metadata
 */
export async function auditDriverAssigned(orderId, driverId, metadata = {}) {
  await createAuditLog({
    eventType: AUDIT_EVENTS.DRIVER_ASSIGNED,
    entityType: 'order',
    entityId: orderId,
    actorType: ACTOR_TYPES.SYSTEM,
    actorId: null,
    changes: {
      before: { driverId: null },
      after: { driverId },
    },
    metadata: {
      ...metadata,
      matchedAt: new Date().toISOString(),
    },
  });
}

/**
 * Query audit logs for an entity
 * @param {string} entityType - Type of entity
 * @param {number} entityId - Entity ID
 * @param {Object} options - Query options (limit, offset)
 * @returns {Array} Audit log entries
 */
export async function getAuditLogs(entityType, entityId, options = {}) {
  const { limit = 50, offset = 0 } = options;

  const result = await query(
    `SELECT * FROM audit_logs
     WHERE entity_type = $1 AND entity_id = $2
     ORDER BY created_at DESC
     LIMIT $3 OFFSET $4`,
    [entityType, entityId, limit, offset]
  );

  return result.rows;
}

export default {
  AUDIT_EVENTS,
  ACTOR_TYPES,
  createAuditLog,
  auditOrderStatusChange,
  auditOrderCreated,
  auditDriverAssigned,
  getAuditLogs,
};
