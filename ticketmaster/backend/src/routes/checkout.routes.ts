import { Router, Response } from 'express';
import { checkoutService } from '../services/checkout.service.js';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth.middleware.js';

const router = Router();

// Process checkout
router.post('/', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { payment_method } = req.body;

    if (!payment_method) {
      res.status(400).json({ success: false, error: 'payment_method is required' });
      return;
    }

    const result = await checkoutService.checkout(
      req.sessionId!,
      req.userId!,
      payment_method
    );

    res.json({
      success: true,
      data: {
        order: result.order,
        items: result.items,
        message: 'Order completed successfully',
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Checkout failed';
    res.status(400).json({ success: false, error: message });
  }
});

// Get user orders
router.get('/orders', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const orders = await checkoutService.getOrdersByUser(req.userId!);
    res.json({ success: true, data: orders });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to get orders';
    res.status(500).json({ success: false, error: message });
  }
});

// Get single order
router.get('/orders/:id', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const order = await checkoutService.getOrderById(req.params.id, req.userId!);

    if (!order) {
      res.status(404).json({ success: false, error: 'Order not found' });
      return;
    }

    res.json({ success: true, data: order });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to get order';
    res.status(500).json({ success: false, error: message });
  }
});

// Cancel order
router.post('/orders/:id/cancel', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await checkoutService.cancelOrder(req.params.id, req.userId!);
    res.json({ success: true, data: { message: 'Order cancelled' } });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to cancel order';
    res.status(400).json({ success: false, error: message });
  }
});

export default router;
