import { Request, Response, NextFunction } from 'express';
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
} as const;

export type ActorTypeValue = typeof ActorType[keyof typeof ActorType];

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
} as const;

export type AuditActionValue = typeof AuditAction[keyof typeof AuditAction];

// Audit context interface
export interface AuditContext {
  storeId: number | null;
  userId: number | null;
  userType: ActorTypeValue | string;
  ip?: string;
  userAgent?: string;
}

// Resource interface
export interface AuditResource {
  type: string;
  id: number | string | null;
}

// Changes interface
export interface AuditChanges {
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  delta?: number;
  reason?: string | null;
  details?: Record<string, unknown>;
  success?: boolean;
  amount?: number;
  orderId?: number | null;
  error?: string | null;
  [key: string]: unknown;
}

// Order interface for audit logging
interface OrderForAudit {
  id: number;
  order_number: string;
  total: number;
  customer_email: string;
  items?: Array<{
    variantId: number;
    quantity: number;
    price: number;
  }>;
}

// Payment details interface
interface PaymentDetails {
  paymentIntentId?: string | null;
  amount: number;
  orderId?: number | null;
  error?: string | null;
}

/**
 * Create an audit log entry
 * @param context - Actor context
 * @param action - Action performed
 * @param resource - Resource affected
 * @param changes - Before/after state
 */
export async function createAuditLog(
  context: AuditContext,
  action: AuditActionValue | string,
  resource: AuditResource,
  changes: AuditChanges = {}
): Promise<void> {
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
 * @param context - Actor context
 * @param variantId - Variant ID
 * @param oldQuantity - Previous quantity
 * @param newQuantity - New quantity
 * @param reason - Reason for change
 */
export async function logInventoryChange(
  context: AuditContext,
  variantId: number,
  oldQuantity: number,
  newQuantity: number,
  reason: string | null = null
): Promise<void> {
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
 * @param context - Actor context
 * @param order - Order data
 */
export async function logOrderCreated(
  context: AuditContext,
  order: OrderForAudit
): Promise<void> {
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
 * @param context - Actor context
 * @param orderId - Order ID
 * @param before - Previous state
 * @param after - New state
 */
export async function logOrderUpdated(
  context: AuditContext,
  orderId: number,
  before: Record<string, unknown>,
  after: Record<string, unknown>
): Promise<void> {
  await createAuditLog(
    context,
    AuditAction.ORDER_UPDATED,
    { type: 'order', id: orderId },
    { before, after }
  );
}

/**
 * Log checkout event
 * @param context - Actor context
 * @param action - Checkout action
 * @param details - Event details
 */
export async function logCheckoutEvent(
  context: AuditContext,
  action: AuditActionValue | string,
  details: Record<string, unknown>
): Promise<void> {
  await createAuditLog(
    context,
    action,
    { type: 'checkout', id: (details.cartId || details.orderId) as string | number | null },
    { details }
  );
}

/**
 * Log payment event
 * @param context - Actor context
 * @param success - Whether payment succeeded
 * @param paymentDetails - Payment details
 */
export async function logPaymentEvent(
  context: AuditContext,
  success: boolean,
  paymentDetails: PaymentDetails
): Promise<void> {
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

// Audit log row interface
interface AuditLogRow {
  id: number;
  store_id: number;
  actor_id: number | null;
  actor_type: string;
  action: string;
  resource_type: string;
  resource_id: number | string | null;
  changes: Record<string, unknown>;
  ip_address: string | null;
  user_agent: string | null;
  created_at: Date;
}

/**
 * Query audit logs for a resource
 * @param storeId - Store ID
 * @param resourceType - Resource type
 * @param resourceId - Resource ID
 * @returns Audit log entries
 */
export async function getAuditLogsForResource(
  storeId: number,
  resourceType: string,
  resourceId: number
): Promise<AuditLogRow[]> {
  const result = await query(
    `SELECT * FROM audit_logs
     WHERE store_id = $1 AND resource_type = $2 AND resource_id = $3
     ORDER BY created_at DESC
     LIMIT 100`,
    [storeId, resourceType, resourceId]
  );
  return result.rows as AuditLogRow[];
}

/**
 * Query audit logs by action
 * @param storeId - Store ID
 * @param action - Action to filter by
 * @param limit - Maximum results
 * @returns Audit log entries
 */
export async function getAuditLogsByAction(
  storeId: number,
  action: string,
  limit: number = 100
): Promise<AuditLogRow[]> {
  const result = await query(
    `SELECT * FROM audit_logs
     WHERE store_id = $1 AND action = $2
     ORDER BY created_at DESC
     LIMIT $3`,
    [storeId, action, limit]
  );
  return result.rows as AuditLogRow[];
}

/**
 * Query audit logs by actor
 * @param storeId - Store ID
 * @param actorId - Actor ID
 * @param limit - Maximum results
 * @returns Audit log entries
 */
export async function getAuditLogsByActor(
  storeId: number,
  actorId: number,
  limit: number = 100
): Promise<AuditLogRow[]> {
  const result = await query(
    `SELECT * FROM audit_logs
     WHERE store_id = $1 AND actor_id = $2
     ORDER BY created_at DESC
     LIMIT $3`,
    [storeId, actorId, limit]
  );
  return result.rows as AuditLogRow[];
}

/**
 * Get audit trail for an order (dispute resolution)
 * @param storeId - Store ID
 * @param orderId - Order ID
 * @returns Complete audit trail
 */
export async function getOrderAuditTrail(
  storeId: number,
  orderId: number
): Promise<AuditLogRow[]> {
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
  return result.rows as AuditLogRow[];
}

// Extend Express Request to include auditContext
declare global {
  namespace Express {
    interface Request {
      auditContext?: AuditContext;
    }
  }
}

/**
 * Express middleware to extract audit context from request
 */
export function auditContextMiddleware(req: Request, _res: Response, next: NextFunction): void {
  const typedReq = req as Request & { storeId?: number; user?: { id: number; role: string } };
  req.auditContext = {
    storeId: typedReq.storeId || null,
    userId: typedReq.user?.id || null,
    userType: typedReq.user?.role || ActorType.SYSTEM,
    ip: req.ip || req.socket?.remoteAddress,
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
