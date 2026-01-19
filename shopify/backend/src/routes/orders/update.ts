import { Request, Response } from 'express';
import { queryWithTenant } from '../../services/db.js';
import { ActorType, AuditContext } from '../../services/audit.js';
import type { Order } from './types.js';

/**
 * Updates an order's status fields (payment, fulfillment, notes).
 *
 * @description Allows merchants to update order status fields. Supports partial updates
 * where only provided fields are modified. All changes are recorded in the audit log
 * for compliance and dispute resolution.
 *
 * @param req - Express request object with storeId, orderId params, and body containing
 *              optional fields: payment_status, fulfillment_status, notes
 * @param res - Express response object
 * @returns Promise that resolves when the response is sent
 *
 * @throws Returns 404 JSON response if order is not found
 * @throws Returns 400 JSON response if no fields are provided for update
 *
 * @example
 * // PATCH /api/v1/orders/123
 * // Body: { "fulfillment_status": "fulfilled", "notes": "Shipped via FedEx" }
 * // Response: { order: { id: 123, fulfillment_status: "fulfilled", ... } }
 */
export async function updateOrder(req: Request, res: Response): Promise<void | Response> {
  const { storeId } = req;
  const { orderId } = req.params;
  const { payment_status, fulfillment_status, notes } = req.body;

  // Get current state for audit
  const currentResult = await queryWithTenant(
    storeId!,
    'SELECT payment_status, fulfillment_status, notes FROM orders WHERE id = $1',
    [orderId]
  );

  if (currentResult.rows.length === 0) {
    return res.status(404).json({ error: 'Order not found' });
  }

  const before = currentResult.rows[0] as { payment_status: string; fulfillment_status: string; notes: string };

  const updates: string[] = [];
  const values: unknown[] = [];
  let paramCount = 1;

  if (payment_status !== undefined) {
    updates.push(`payment_status = $${paramCount++}`);
    values.push(payment_status);
  }
  if (fulfillment_status !== undefined) {
    updates.push(`fulfillment_status = $${paramCount++}`);
    values.push(fulfillment_status);
  }
  if (notes !== undefined) {
    updates.push(`notes = $${paramCount++}`);
    values.push(notes);
  }

  if (updates.length === 0) {
    return res.status(400).json({ error: 'No fields to update' });
  }

  updates.push(`updated_at = NOW()`);
  values.push(orderId);

  const result = await queryWithTenant(
    storeId!,
    `UPDATE orders SET ${updates.join(', ')} WHERE id = $${paramCount}
     RETURNING *`,
    values
  );

  const order = result.rows[0] as Order;

  // Audit log the update
  const auditContext: AuditContext = {
    storeId: storeId!,
    userId: req.user?.id || null,
    userType: req.user?.role || ActorType.MERCHANT,
    ip: req.ip,
    userAgent: req.headers['user-agent'] as string | undefined,
  };

  const { logOrderUpdated } = await import('../../services/audit.js');
  await logOrderUpdated(
    auditContext,
    parseInt(orderId),
    before,
    { payment_status: order.payment_status, fulfillment_status: order.fulfillment_status, notes: order.notes }
  );

  res.json({ order });
}
