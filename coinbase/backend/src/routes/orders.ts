import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { orderLimiter } from '../services/rateLimiter.js';
import * as orderService from '../services/orderService.js';

const router = Router();

// POST /api/v1/orders - Place a new order
/** POST /api/v1/orders - Places a market or limit order with idempotency support. */
router.post('/', requireAuth, orderLimiter, async (req: Request, res: Response) => {
  try {
    const userId = req.session.userId!;
    const { tradingPairId, side, orderType, quantity, price, stopPrice, idempotencyKey } =
      req.body;

    if (!tradingPairId || !side || !orderType || !quantity) {
      res.status(400).json({ error: 'Missing required fields' });
      return;
    }

    if (!['buy', 'sell'].includes(side)) {
      res.status(400).json({ error: 'Side must be buy or sell' });
      return;
    }

    if (!['market', 'limit', 'stop'].includes(orderType)) {
      res.status(400).json({ error: 'Order type must be market, limit, or stop' });
      return;
    }

    const result = await orderService.placeOrder(userId, {
      tradingPairId,
      side,
      orderType,
      quantity: quantity.toString(),
      price: price?.toString(),
      stopPrice: stopPrice?.toString(),
      idempotencyKey,
    });

    res.status(201).json({ order: result });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to place order';
    const status = message.includes('Insufficient') ? 400 : 500;
    res.status(status).json({ error: message });
  }
});

// DELETE /api/v1/orders/:id - Cancel an order
/** DELETE /api/v1/orders/:id - Cancels an open order and releases reserved funds. */
router.delete('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.session.userId!;
    const { id } = req.params;

    const cancelled = await orderService.cancelOrder(userId, String(id));

    if (!cancelled) {
      res.status(404).json({ error: 'Order not found or cannot be cancelled' });
      return;
    }

    res.json({ message: 'Order cancelled successfully' });
  } catch (error) {
    console.error('Cancel order error:', error);
    res.status(500).json({ error: 'Failed to cancel order' });
  }
});

// GET /api/v1/orders - Get user orders
/** GET /api/v1/orders - Returns the user's order history with optional status filter. */
router.get('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.session.userId!;
    const status = req.query.status as string | undefined;
    const limit = parseInt(req.query.limit as string) || 50;

    const orders = await orderService.getUserOrders(userId, status, limit);
    res.json({ orders });
  } catch (error) {
    console.error('Get orders error:', error);
    res.status(500).json({ error: 'Failed to get orders' });
  }
});

export default router;
