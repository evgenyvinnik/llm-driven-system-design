import { Router, Response } from 'express';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth.js';
import { orderService, PlaceOrderRequest } from '../services/orderService.js';

const router = Router();

// All order routes require authentication
router.use(authMiddleware);

// Place an order
router.post('/', async (req: AuthenticatedRequest, res: Response) => {
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

    const result = await orderService.placeOrder(userId, orderRequest);
    res.status(201).json(result);
  } catch (error) {
    console.error('Order placement error:', error);
    res.status(400).json({ error: (error as Error).message });
  }
});

// Get all orders for user
router.get('/', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const status = req.query.status as string | undefined;
    const orders = await orderService.getOrders(userId, status);
    res.json(orders);
  } catch (error) {
    console.error('Get orders error:', error);
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

// Get specific order
router.get('/:orderId', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const order = await orderService.getOrder(userId, req.params.orderId);

    if (!order) {
      res.status(404).json({ error: 'Order not found' });
      return;
    }

    res.json(order);
  } catch (error) {
    console.error('Get order error:', error);
    res.status(500).json({ error: 'Failed to fetch order' });
  }
});

// Get executions for an order
router.get('/:orderId/executions', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const order = await orderService.getOrder(userId, req.params.orderId);

    if (!order) {
      res.status(404).json({ error: 'Order not found' });
      return;
    }

    const executions = await orderService.getExecutions(order.id);
    res.json(executions);
  } catch (error) {
    console.error('Get executions error:', error);
    res.status(500).json({ error: 'Failed to fetch executions' });
  }
});

// Cancel an order
router.delete('/:orderId', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const order = await orderService.cancelOrder(userId, req.params.orderId);
    res.json({ message: 'Order cancelled', order });
  } catch (error) {
    console.error('Cancel order error:', error);
    res.status(400).json({ error: (error as Error).message });
  }
});

export default router;
