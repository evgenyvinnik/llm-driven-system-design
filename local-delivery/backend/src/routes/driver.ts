import { Router } from 'express';
import type { Request, Response } from 'express';
import { authenticate, requireDriver } from '../middleware/auth.js';
import {
  getDriverById,
  getDriverWithUser,
  updateDriverStatus,
  updateDriverLocation,
  getDriverStats,
} from '../services/driverService.js';
import {
  getDriverOrders,
  getOrderWithDetails,
  acceptDriverOffer,
  rejectDriverOffer,
  updateOrderStatus,
  completeDelivery,
  getPendingOfferForDriver,
} from '../services/orderService.js';
import { publisher } from '../utils/redis.js';

const router = Router();

// Get driver profile
router.get('/profile', authenticate, requireDriver, async (req: Request, res: Response) => {
  try {
    const driver = await getDriverWithUser(req.userId!);

    if (!driver) {
      res.status(404).json({
        success: false,
        error: 'Driver profile not found',
      });
      return;
    }

    const stats = await getDriverStats(req.userId!);

    res.json({
      success: true,
      data: {
        ...driver,
        stats,
      },
    });
  } catch (error) {
    console.error('Get driver profile error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get driver profile',
    });
  }
});

// Go online
router.post('/go-online', authenticate, requireDriver, async (req: Request, res: Response) => {
  try {
    const { lat, lng } = req.body;

    if (!lat || !lng) {
      res.status(400).json({
        success: false,
        error: 'Location (lat, lng) is required',
      });
      return;
    }

    // Update status and location
    const driver = await updateDriverStatus(req.userId!, 'available');

    if (driver) {
      await updateDriverLocation(req.userId!, lat, lng);
    }

    res.json({
      success: true,
      data: driver,
      message: 'You are now online',
    });
  } catch (error) {
    console.error('Go online error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to go online',
    });
  }
});

// Go offline
router.post('/go-offline', authenticate, requireDriver, async (req: Request, res: Response) => {
  try {
    // Check if driver has active orders
    const activeOrders = await getDriverOrders(req.userId!);

    if (activeOrders.length > 0) {
      res.status(400).json({
        success: false,
        error: 'Cannot go offline with active deliveries',
      });
      return;
    }

    const driver = await updateDriverStatus(req.userId!, 'offline');

    res.json({
      success: true,
      data: driver,
      message: 'You are now offline',
    });
  } catch (error) {
    console.error('Go offline error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to go offline',
    });
  }
});

// Update location
router.post('/location', authenticate, requireDriver, async (req: Request, res: Response) => {
  try {
    const { lat, lng, speed, heading } = req.body;

    if (!lat || !lng) {
      res.status(400).json({
        success: false,
        error: 'Location (lat, lng) is required',
      });
      return;
    }

    await updateDriverLocation(req.userId!, lat, lng);

    res.json({
      success: true,
      message: 'Location updated',
    });
  } catch (error) {
    console.error('Update location error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update location',
    });
  }
});

// Get current orders
router.get('/orders', authenticate, requireDriver, async (req: Request, res: Response) => {
  try {
    const orders = await getDriverOrders(req.userId!);

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

// Get pending offer
router.get('/offers/pending', authenticate, requireDriver, async (req: Request, res: Response) => {
  try {
    const offer = await getPendingOfferForDriver(req.userId!);

    if (!offer) {
      res.json({
        success: true,
        data: null,
      });
      return;
    }

    const order = await getOrderWithDetails(offer.order_id);

    res.json({
      success: true,
      data: {
        offer,
        order,
      },
    });
  } catch (error) {
    console.error('Get pending offer error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get pending offer',
    });
  }
});

// Accept offer
router.post('/offers/:id/accept', authenticate, requireDriver, async (req: Request, res: Response) => {
  try {
    const order = await acceptDriverOffer(req.params.id, req.userId!);

    if (!order) {
      res.status(400).json({
        success: false,
        error: 'Offer expired or already responded',
      });
      return;
    }

    const orderWithDetails = await getOrderWithDetails(order.id);

    res.json({
      success: true,
      data: orderWithDetails,
      message: 'Order accepted',
    });
  } catch (error) {
    console.error('Accept offer error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to accept offer',
    });
  }
});

// Reject offer
router.post('/offers/:id/reject', authenticate, requireDriver, async (req: Request, res: Response) => {
  try {
    const success = await rejectDriverOffer(req.params.id, req.userId!);

    if (!success) {
      res.status(400).json({
        success: false,
        error: 'Offer not found or already responded',
      });
      return;
    }

    res.json({
      success: true,
      message: 'Offer rejected',
    });
  } catch (error) {
    console.error('Reject offer error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to reject offer',
    });
  }
});

// Mark order as picked up
router.post('/orders/:id/picked-up', authenticate, requireDriver, async (req: Request, res: Response) => {
  try {
    const order = await getOrderWithDetails(req.params.id);

    if (!order) {
      res.status(404).json({
        success: false,
        error: 'Order not found',
      });
      return;
    }

    if (order.driver_id !== req.userId) {
      res.status(403).json({
        success: false,
        error: 'Access denied',
      });
      return;
    }

    if (!['driver_assigned', 'ready_for_pickup'].includes(order.status)) {
      res.status(400).json({
        success: false,
        error: 'Order is not ready for pickup',
      });
      return;
    }

    const updatedOrder = await updateOrderStatus(req.params.id, 'picked_up');

    res.json({
      success: true,
      data: updatedOrder,
      message: 'Order marked as picked up',
    });
  } catch (error) {
    console.error('Pickup order error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to pickup order',
    });
  }
});

// Mark order as in transit
router.post('/orders/:id/in-transit', authenticate, requireDriver, async (req: Request, res: Response) => {
  try {
    const order = await getOrderWithDetails(req.params.id);

    if (!order) {
      res.status(404).json({
        success: false,
        error: 'Order not found',
      });
      return;
    }

    if (order.driver_id !== req.userId) {
      res.status(403).json({
        success: false,
        error: 'Access denied',
      });
      return;
    }

    if (order.status !== 'picked_up') {
      res.status(400).json({
        success: false,
        error: 'Order must be picked up first',
      });
      return;
    }

    const updatedOrder = await updateOrderStatus(req.params.id, 'in_transit');

    res.json({
      success: true,
      data: updatedOrder,
      message: 'Order in transit',
    });
  } catch (error) {
    console.error('In transit error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update order',
    });
  }
});

// Mark order as delivered
router.post('/orders/:id/delivered', authenticate, requireDriver, async (req: Request, res: Response) => {
  try {
    const order = await getOrderWithDetails(req.params.id);

    if (!order) {
      res.status(404).json({
        success: false,
        error: 'Order not found',
      });
      return;
    }

    if (order.driver_id !== req.userId) {
      res.status(403).json({
        success: false,
        error: 'Access denied',
      });
      return;
    }

    if (!['picked_up', 'in_transit'].includes(order.status)) {
      res.status(400).json({
        success: false,
        error: 'Order must be picked up first',
      });
      return;
    }

    const updatedOrder = await completeDelivery(req.params.id);

    res.json({
      success: true,
      data: updatedOrder,
      message: 'Order delivered successfully',
    });
  } catch (error) {
    console.error('Deliver order error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to deliver order',
    });
  }
});

// Get driver stats
router.get('/stats', authenticate, requireDriver, async (req: Request, res: Response) => {
  try {
    const stats = await getDriverStats(req.userId!);

    res.json({
      success: true,
      data: stats,
    });
  } catch (error) {
    console.error('Get stats error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get stats',
    });
  }
});

export default router;
