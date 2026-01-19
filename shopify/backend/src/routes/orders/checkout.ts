import { Request, Response } from 'express';
import logger from '../../services/logger.js';
import { withIdempotency } from '../../services/idempotency.js';
import { logCheckoutEvent, AuditAction, ActorType, AuditContext } from '../../services/audit.js';
import { checkoutsTotal, checkoutLatency } from '../../services/metrics.js';
import { processCheckoutInternal } from './checkout-processor.js';
import type { Address } from './types.js';

/**
 * Processes a checkout request to create an order from the cart.
 *
 * @description Handles the complete checkout flow with several reliability patterns:
 * - **Idempotency**: Prevents duplicate orders if the client retries (via idempotency-key header)
 * - **Audit logging**: Tracks checkout events for compliance and dispute resolution
 * - **Circuit breaker**: Protects against payment gateway failures
 * - **Async queues**: Ensures reliable delivery of order notifications
 * - **Metrics**: Tracks checkout latency and success/failure rates
 *
 * The function validates the request, logs the checkout start, processes payment
 * and inventory updates atomically, and queues post-order notifications.
 *
 * @param req - Express request object containing:
 *   - storeId: Current store ID (from middleware)
 *   - body.email: Customer email address (required)
 *   - body.shippingAddress: Optional shipping address
 *   - body.billingAddress: Optional billing address
 *   - cookies.cartSession or headers['x-cart-session']: Cart session ID
 *   - headers['idempotency-key']: Optional key for idempotent requests
 * @param res - Express response object
 * @returns Promise that resolves when the response is sent
 *
 * @throws Returns 404 JSON response if store is not found
 * @throws Returns 400 JSON response if cart session or email is missing
 * @throws Throws error if checkout processing fails (after logging and metrics)
 *
 * @example
 * // POST /api/v1/checkout
 * // Headers: { "Idempotency-Key": "unique-checkout-123" }
 * // Body: {
 * //   "email": "customer@example.com",
 * //   "shippingAddress": { "address1": "123 Main St", "city": "NYC", "zip": "10001" }
 * // }
 * // Response (201): { order: { id: 456, order_number: "ORD-ABC123", total: 59.99, ... } }
 *
 * // Deduplicated response (200):
 * // { order: { ... }, deduplicated: true }
 */
export async function checkout(req: Request, res: Response): Promise<void | Response> {
  const { storeId } = req;
  const { email, shippingAddress, billingAddress } = req.body as {
    email: string;
    shippingAddress?: Address;
    billingAddress?: Address;
  };
  const sessionId = req.cookies?.cartSession || req.headers['x-cart-session'] as string | undefined;
  const idempotencyKey = (req.headers['idempotency-key'] || req.headers['x-idempotency-key']) as string | undefined;

  const checkoutStartTime = Date.now();

  const auditContext: AuditContext = {
    storeId: storeId!,
    userId: null,
    userType: ActorType.CUSTOMER,
    ip: req.ip || req.socket?.remoteAddress,
    userAgent: req.headers['user-agent'] as string | undefined,
  };

  if (!storeId) {
    return res.status(404).json({ error: 'Store not found' });
  }

  if (!sessionId) {
    return res.status(400).json({ error: 'No cart session' });
  }

  if (!email) {
    return res.status(400).json({ error: 'Email required' });
  }

  await logCheckoutEvent(auditContext, AuditAction.CHECKOUT_STARTED, { cartId: sessionId, email });

  try {
    if (idempotencyKey) {
      const { result, deduplicated } = await withIdempotency(
        idempotencyKey,
        storeId,
        'checkout',
        async () => processCheckoutInternal(storeId, sessionId, email, shippingAddress, billingAddress, auditContext),
        { email, cartSession: sessionId }
      );

      recordMetrics(storeId, checkoutStartTime, 'success');

      if (deduplicated) {
        logger.info({ storeId, idempotencyKey }, 'Checkout deduplicated via idempotency key');
        return res.status(200).json({ order: result, deduplicated: true });
      }

      res.clearCookie('cartSession');
      return res.status(201).json({ order: result });
    }

    const order = await processCheckoutInternal(storeId, sessionId, email, shippingAddress, billingAddress, auditContext);

    recordMetrics(storeId, checkoutStartTime, 'success');

    res.clearCookie('cartSession');
    res.status(201).json({ order });
  } catch (error) {
    recordMetrics(storeId, checkoutStartTime, 'failed');

    await logCheckoutEvent(auditContext, AuditAction.CHECKOUT_FAILED, {
      cartId: sessionId,
      error: (error as Error).message,
    });

    logger.error({ err: error, storeId, sessionId }, 'Checkout failed');
    throw error;
  }
}

/**
 * Records checkout performance metrics for monitoring and alerting.
 *
 * @description Updates Prometheus metrics for checkout latency and total counts.
 * Used internally by the checkout handler to track success and failure rates.
 *
 * @param storeId - Store ID for metric labeling
 * @param startTime - Timestamp when checkout started (from Date.now())
 * @param status - Checkout result: 'success' or 'failed'
 */
function recordMetrics(storeId: number, startTime: number, status: 'success' | 'failed'): void {
  const latency = (Date.now() - startTime) / 1000;
  checkoutLatency.observe({ store_id: storeId.toString(), status }, latency);
  checkoutsTotal.inc({ store_id: storeId.toString(), status });
}
