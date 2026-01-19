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
import { Request } from 'express';
import { Socket } from 'net';
import { query } from '../services/database.js';
import logger from './logger.js';
import { auditEventsTotal } from './metrics.js';

// Extended Request for audit context
interface ExtendedRequest extends Request {
  correlationId?: string;
  connection?: Socket & { remoteAddress?: string };
}

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
} as const;

export type AuditEventType = (typeof AuditEventTypes)[keyof typeof AuditEventTypes];

// Severity levels for audit events
export const AuditSeverity = {
  INFO: 'info',
  WARNING: 'warning',
  CRITICAL: 'critical'
} as const;

export type AuditSeverityType = (typeof AuditSeverity)[keyof typeof AuditSeverity];

// Actor types
export const ActorType = {
  USER: 'user',
  ADMIN: 'admin',
  SYSTEM: 'system',
  SERVICE: 'service'
} as const;

export type ActorTypeValue = (typeof ActorType)[keyof typeof ActorType];

interface Actor {
  id: number | null;
  type: ActorTypeValue;
  email?: string;
}

interface Resource {
  type: string;
  id: number | string;
}

interface Changes {
  old?: Record<string, unknown>;
  new?: Record<string, unknown>;
}

interface AuditContext {
  ip?: string | string[];
  userAgent?: string;
  correlationId?: string;
}

interface AuditEntry {
  action: string;
  actor: Actor;
  resource: Resource;
  changes?: Changes;
  context?: AuditContext;
  severity?: AuditSeverityType;
}

interface AuditLogRow {
  id: number;
  action: string;
  actor_id: number | null;
  actor_type: string;
  resource_type: string;
  resource_id: string;
  old_value: string | null;
  new_value: string | null;
  ip_address: string | null;
  user_agent: string | null;
  correlation_id: string | null;
  severity: string;
  created_at: Date;
}

interface AuditQueryFilters {
  action?: string;
  actorId?: number;
  actorType?: string;
  resourceType?: string;
  resourceId?: string | number;
  startDate?: Date | string;
  endDate?: Date | string;
  severity?: string;
  page?: number;
  limit?: number;
}

interface CartItem {
  product_id: number;
  quantity: number;
}

interface Order {
  id: number;
  total?: string;
  payment_method?: string;
  status?: string;
  payment_status?: string;
}

interface PaymentDetails {
  transactionId?: string;
  amount?: string;
  method?: string;
  lastFour?: string;
}

/**
 * Create an audit log entry
 */
export async function createAuditLog(entry: AuditEntry): Promise<number | null> {
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
    const result = await query<{ id: number }>(
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
    const err = error as Error;
    // Audit logging should never break the main flow
    logger.error({ error: err.message, action, resource }, 'Failed to create audit log');
    return null;
  }
}

/**
 * Create audit context from Express request
 */
export function createAuditContext(req: ExtendedRequest): AuditContext {
  return {
    ip: req.ip || (req.headers['x-forwarded-for'] as string) || req.connection?.remoteAddress,
    userAgent: req.headers['user-agent'],
    correlationId: req.correlationId || (req.headers['x-correlation-id'] as string)
  };
}

/**
 * Create actor object from request
 */
export function createActor(req: ExtendedRequest): Actor {
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
 */
export async function auditOrderCreated(
  req: ExtendedRequest,
  order: Order,
  cartItems: CartItem[] = []
): Promise<void> {
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
 */
export async function auditOrderCancelled(
  req: ExtendedRequest,
  order: Order,
  reason: string = ''
): Promise<void> {
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
 */
export async function auditOrderStatusChanged(
  req: ExtendedRequest,
  orderId: number | string,
  oldStatus: string,
  newStatus: string
): Promise<void> {
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
 */
export async function auditOrderRefunded(
  req: ExtendedRequest,
  order: Order,
  amount: number,
  reason: string = ''
): Promise<void> {
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
 */
export async function auditPaymentCompleted(
  req: ExtendedRequest,
  orderId: number,
  paymentDetails: PaymentDetails
): Promise<void> {
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
 */
export async function auditPaymentFailed(
  req: ExtendedRequest,
  orderId: number,
  errorCode: string,
  errorMessage: string
): Promise<void> {
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
 */
export async function auditInventoryReserved(
  req: ExtendedRequest,
  productId: number,
  quantity: number,
  reason: string = 'cart'
): Promise<void> {
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
 */
export async function auditInventoryReleased(
  req: ExtendedRequest | null,
  productId: number,
  quantity: number,
  reason: string = 'expiry'
): Promise<void> {
  const actor: Actor = req
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
 */
export async function auditAdminAction(
  req: ExtendedRequest,
  action: string,
  resource: Resource,
  changes: Changes
): Promise<void> {
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
 */
export async function queryAuditLogs(filters: AuditQueryFilters = {}): Promise<{
  logs: AuditLogRow[];
  total: number;
  page: number;
  limit: number;
}> {
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
  const params: unknown[] = [];

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

  const result = await query<AuditLogRow>(
    `SELECT * FROM audit_logs ${whereClause}
     ORDER BY created_at DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset]
  );

  const countResult = await query<{ total: string }>(
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
 */
export async function getOrderAuditTrail(orderId: number): Promise<AuditLogRow[]> {
  const result = await query<AuditLogRow>(
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
