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
} as const;

/**
 * Actor types for audit logs
 */
export const ACTOR_TYPES = {
  CUSTOMER: 'customer',
  DRIVER: 'driver',
  RESTAURANT: 'restaurant',
  ADMIN: 'admin',
  SYSTEM: 'system',
} as const;

export type AuditEventType = (typeof AUDIT_EVENTS)[keyof typeof AUDIT_EVENTS];
export type ActorType = (typeof ACTOR_TYPES)[keyof typeof ACTOR_TYPES];

export interface AuditEvent {
  eventType: AuditEventType | string;
  entityType: string;
  entityId: number | string;
  actorType: ActorType | string;
  actorId?: number | null;
  changes?: {
    before: Record<string, unknown> | null;
    after: Record<string, unknown> | null;
  } | null;
  metadata?: Record<string, unknown>;
}

export interface Actor {
  type: ActorType | string;
  id: number | null;
}

export interface OrderForAudit {
  id: number;
  status?: string;
  total?: number;
  customer_id?: number;
  restaurant_id?: number;
  driver_id?: number | null;
  items?: unknown[];
}

export interface AuditLogRow {
  id: number;
  event_type: string;
  entity_type: string;
  entity_id: number;
  actor_type: string;
  actor_id: number | null;
  changes: string | null;
  metadata: string;
  created_at: Date;
}

interface GetAuditLogsOptions {
  limit?: number;
  offset?: number;
}

/**
 * Create an audit log entry
 */
export async function createAuditLog(event: AuditEvent): Promise<void> {
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

    logger.debug(
      {
        eventType,
        entityType,
        entityId,
        actorType,
        actorId,
      },
      'Audit log created'
    );
  } catch (error) {
    const err = error as Error;
    // Log error but don't throw - audit logging shouldn't break the main flow
    logger.error(
      {
        error: err.message,
        event,
      },
      'Failed to create audit log'
    );
  }
}

/**
 * Audit log for order status change
 */
export async function auditOrderStatusChange(
  order: OrderForAudit,
  fromStatus: string,
  toStatus: string,
  actor: Actor,
  metadata: Record<string, unknown> = {}
): Promise<void> {
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
 */
export async function auditOrderCreated(
  order: OrderForAudit,
  actor: Actor,
  metadata: Record<string, unknown> = {}
): Promise<void> {
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
 */
export async function auditDriverAssigned(
  orderId: number,
  driverId: number,
  metadata: Record<string, unknown> = {}
): Promise<void> {
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
 */
export async function getAuditLogs(
  entityType: string,
  entityId: number | string,
  options: GetAuditLogsOptions = {}
): Promise<AuditLogRow[]> {
  const { limit = 50, offset = 0 } = options;

  const result = await query(
    `SELECT * FROM audit_logs
     WHERE entity_type = $1 AND entity_id = $2
     ORDER BY created_at DESC
     LIMIT $3 OFFSET $4`,
    [entityType, entityId, limit, offset]
  );

  return result.rows as AuditLogRow[];
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
