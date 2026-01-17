import { Router, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth.js';
import { orderService, PlaceOrderRequest, OrderContext } from '../services/orderService.js';
import { logger } from '../shared/logger.js';

/**
 * Express router for order management endpoints.
 * All routes require authentication.
 * Handles order placement, retrieval, and cancellation.
 *
 * Enhanced with:
 * - Idempotency key support via X-Idempotency-Key header
 * - Request tracing via X-Request-ID header
 * - Structured logging
 */
const router = Router();

// All order routes require authentication
router.use(authMiddleware);

/**
 * Extracts order context from request headers.
 * @param req - Express request
 * @returns Order context with idempotency key and tracing info
 */
function extractOrderContext(req: AuthenticatedRequest): OrderContext {
  return {
    idempotencyKey: req.headers['x-idempotency-key'] as string | undefined,
    requestId: (req.headers['x-request-id'] as string) || uuidv4(),
    ipAddress: req.ip || req.socket.remoteAddress,
    userAgent: req.headers['user-agent'],
  };
}

/**
 * POST /api/orders
 * Places a new buy or sell order.
 * Supports market, limit, stop, and stop-limit order types.
 *
 * Headers:
 * - X-Idempotency-Key: Optional unique key to prevent duplicate orders
 * - X-Request-ID: Optional request ID for tracing
 *
 * Body:
 * - symbol: Stock ticker symbol (required)
 * - side: 'buy' or 'sell' (required)
 * - orderType: 'market', 'limit', 'stop', 'stop_limit' (default: 'market')
 * - quantity: Number of shares (required)
 * - limitPrice: Price for limit orders
 * - stopPrice: Price for stop orders
 * - timeInForce: 'day', 'gtc', 'ioc', 'fok' (default: 'day')
 */
router.post('/', async (req: AuthenticatedRequest, res: Response) => {
  const context = extractOrderContext(req);
  const routeLogger = logger.child({
    route: 'POST /api/orders',
    userId: req.user!.id,
    requestId: context.requestId,
  });

  try {
    const userId = req.user!.id;
    const orderRequest: PlaceOrderRequest = {
      symbol: req.body.symbol,
      side: req.body.side,
      order_type: req.body.orderType || req.body.order_type || 'market',
      quantity: parseFloat(req.body.quantity),
      limit_price: req.body.limitPrice ? parseFloat(req.body.limitPrice) : undefined,
      stop_price: req.body.stopPrice ? parseFloat(req.body.stopPrice) : undefined,
      time_in_force: req.body.timeInForce || 'day',
    };

    routeLogger.info({ orderRequest }, 'Processing order placement request');

    const result = await orderService.placeOrder(userId, orderRequest, context);

    // If this was an idempotent response, indicate it in headers
    if (result.idempotent) {
      res.setHeader('X-Idempotent-Response', 'true');
    }

    res.setHeader('X-Request-ID', context.requestId!);
    res.status(201).json(result);
  } catch (error) {
    routeLogger.error({ error: (error as Error).message }, 'Order placement error');
    res.status(400).json({
      error: (error as Error).message,
      requestId: context.requestId,
    });
  }
});

/**
 * GET /api/orders
 * Returns all orders for the authenticated user.
 * Optionally filter by status with ?status=filled|pending|cancelled
 */
router.get('/', async (req: AuthenticatedRequest, res: Response) => {
  const requestId = (req.headers['x-request-id'] as string) || uuidv4();

  try {
    const userId = req.user!.id;
    const status = req.query.status as string | undefined;
    const orders = await orderService.getOrders(userId, status);
    res.setHeader('X-Request-ID', requestId);
    res.json(orders);
  } catch (error) {
    logger.error({ error, requestId }, 'Get orders error');
    res.status(500).json({ error: 'Failed to fetch orders', requestId });
  }
});

/**
 * GET /api/orders/:orderId
 * Returns details for a specific order.
 */
router.get('/:orderId', async (req: AuthenticatedRequest, res: Response) => {
  const requestId = (req.headers['x-request-id'] as string) || uuidv4();

  try {
    const userId = req.user!.id;
    const order = await orderService.getOrder(userId, req.params.orderId);

    if (!order) {
      res.status(404).json({ error: 'Order not found', requestId });
      return;
    }

    res.setHeader('X-Request-ID', requestId);
    res.json(order);
  } catch (error) {
    logger.error({ error, requestId }, 'Get order error');
    res.status(500).json({ error: 'Failed to fetch order', requestId });
  }
});

/**
 * GET /api/orders/:orderId/executions
 * Returns all trade executions for an order.
 * An order may have multiple executions for partial fills.
 */
router.get('/:orderId/executions', async (req: AuthenticatedRequest, res: Response) => {
  const requestId = (req.headers['x-request-id'] as string) || uuidv4();

  try {
    const userId = req.user!.id;
    const order = await orderService.getOrder(userId, req.params.orderId);

    if (!order) {
      res.status(404).json({ error: 'Order not found', requestId });
      return;
    }

    const executions = await orderService.getExecutions(order.id);
    res.setHeader('X-Request-ID', requestId);
    res.json(executions);
  } catch (error) {
    logger.error({ error, requestId }, 'Get executions error');
    res.status(500).json({ error: 'Failed to fetch executions', requestId });
  }
});

/**
 * DELETE /api/orders/:orderId
 * Cancels a pending or partially filled order.
 * Returns error if order is already filled, cancelled, or expired.
 */
router.delete('/:orderId', async (req: AuthenticatedRequest, res: Response) => {
  const context = extractOrderContext(req);
  const routeLogger = logger.child({
    route: 'DELETE /api/orders/:orderId',
    userId: req.user!.id,
    orderId: req.params.orderId,
    requestId: context.requestId,
  });

  try {
    const userId = req.user!.id;
    routeLogger.info('Processing order cancellation request');

    const order = await orderService.cancelOrder(userId, req.params.orderId, context);

    res.setHeader('X-Request-ID', context.requestId!);
    res.json({ message: 'Order cancelled', order });
  } catch (error) {
    routeLogger.error({ error: (error as Error).message }, 'Cancel order error');
    res.status(400).json({
      error: (error as Error).message,
      requestId: context.requestId,
    });
  }
});

export default router;
