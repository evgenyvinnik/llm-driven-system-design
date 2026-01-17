import { Router } from 'express';
import type { Request, Response } from 'express';
import { authenticate, requireCustomer } from '../middleware/auth.js';
import {
  createOrder,
  getOrderWithDetails,
  getCustomerOrders,
  updateOrderStatus,
  startDriverMatching,
} from '../services/orderService.js';
import { createRating } from '../services/ratingService.js';

const router = Router();

// Create new order
router.post('/', authenticate, requireCustomer, async (req: Request, res: Response) => {
  try {
    const order = await createOrder(req.userId!, req.body);

    res.status(201).json({
      success: true,
      data: order,
    });

    // Start driver matching in background (non-blocking)
    startDriverMatching(order.id).catch((error) => {
      console.error('Driver matching error:', error);
    });
  } catch (error) {
    console.error('Create order error:', error);
    res.status(400).json({
      success: false,
      error: (error as Error).message || 'Failed to create order',
    });
  }
});

// Get customer's orders
router.get('/', authenticate, requireCustomer, async (req: Request, res: Response) => {
  try {
    const orders = await getCustomerOrders(req.userId!);

    res.json({
      success: true,
      data: orders,
    });
  } catch (error) {
    console.error('Get orders error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get orders',
    });
  }
});

// Get order by ID
router.get('/:id', authenticate, async (req: Request, res: Response) => {
  try {
    const order = await getOrderWithDetails(req.params.id);

    if (!order) {
      res.status(404).json({
        success: false,
        error: 'Order not found',
      });
      return;
    }

    // Check if user has access to this order
    if (
      order.customer_id !== req.userId &&
      order.driver_id !== req.userId &&
      req.user?.role !== 'admin'
    ) {
      res.status(403).json({
        success: false,
        error: 'Access denied',
      });
      return;
    }

    res.json({
      success: true,
      data: order,
    });
  } catch (error) {
    console.error('Get order error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get order',
    });
  }
});

// Cancel order (customer)
router.post('/:id/cancel', authenticate, requireCustomer, async (req: Request, res: Response) => {
  try {
    const order = await getOrderWithDetails(req.params.id);

    if (!order) {
      res.status(404).json({
        success: false,
        error: 'Order not found',
      });
      return;
    }

    if (order.customer_id !== req.userId) {
      res.status(403).json({
        success: false,
        error: 'Access denied',
      });
      return;
    }

    // Can only cancel pending or confirmed orders
    if (!['pending', 'confirmed'].includes(order.status)) {
      res.status(400).json({
        success: false,
        error: 'Order cannot be cancelled at this stage',
      });
      return;
    }

    const { reason } = req.body;

    const updatedOrder = await updateOrderStatus(req.params.id, 'cancelled', {
      cancellation_reason: reason || 'Cancelled by customer',
    });

    res.json({
      success: true,
      data: updatedOrder,
    });
  } catch (error) {
    console.error('Cancel order error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to cancel order',
    });
  }
});

// Add tip to order
router.post('/:id/tip', authenticate, requireCustomer, async (req: Request, res: Response) => {
  try {
    const order = await getOrderWithDetails(req.params.id);

    if (!order) {
      res.status(404).json({
        success: false,
        error: 'Order not found',
      });
      return;
    }

    if (order.customer_id !== req.userId) {
      res.status(403).json({
        success: false,
        error: 'Access denied',
      });
      return;
    }

    const { tip } = req.body;

    if (typeof tip !== 'number' || tip < 0) {
      res.status(400).json({
        success: false,
        error: 'Invalid tip amount',
      });
      return;
    }

    // Update order with new tip
    const updatedOrder = await updateOrderStatus(order.status, order.status, {
      tip,
      total: order.subtotal + order.delivery_fee + tip,
    });

    res.json({
      success: true,
      data: updatedOrder,
    });
  } catch (error) {
    console.error('Add tip error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to add tip',
    });
  }
});

// Rate driver
router.post('/:id/rate/driver', authenticate, requireCustomer, async (req: Request, res: Response) => {
  try {
    const { rating, comment } = req.body;

    if (!rating || rating < 1 || rating > 5) {
      res.status(400).json({
        success: false,
        error: 'Rating must be between 1 and 5',
      });
      return;
    }

    const ratingRecord = await createRating(
      req.userId!,
      {
        order_id: req.params.id,
        rating,
        comment,
      },
      'driver'
    );

    res.status(201).json({
      success: true,
      data: ratingRecord,
    });
  } catch (error) {
    console.error('Rate driver error:', error);
    res.status(400).json({
      success: false,
      error: (error as Error).message || 'Failed to rate driver',
    });
  }
});

// Rate merchant
router.post('/:id/rate/merchant', authenticate, requireCustomer, async (req: Request, res: Response) => {
  try {
    const { rating, comment } = req.body;

    if (!rating || rating < 1 || rating > 5) {
      res.status(400).json({
        success: false,
        error: 'Rating must be between 1 and 5',
      });
      return;
    }

    const ratingRecord = await createRating(
      req.userId!,
      {
        order_id: req.params.id,
        rating,
        comment,
      },
      'merchant'
    );

    res.status(201).json({
      success: true,
      data: ratingRecord,
    });
  } catch (error) {
    console.error('Rate merchant error:', error);
    res.status(400).json({
      success: false,
      error: (error as Error).message || 'Failed to rate merchant',
    });
  }
});

export default router;
