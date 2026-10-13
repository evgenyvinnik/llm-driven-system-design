/**
 * Driver management routes for the delivery platform.
 * Handles driver status (online/offline), location updates, order management,
 * and offer acceptance/rejection. All routes require driver authentication.
 *
 * @module routes/driver
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { authenticate, requireDriver } from '../middleware/auth.js';
import {
  getDriverWithUser,
  goOnline,
  goOffline,
  updateDriverLocation,
  getDriverStats,
} from '../services/driverService.js';
import {
  getDriverOrders,
  getOrderWithDetails,
  acceptDriverOffer,
  rejectDriverOffer,
  transitionOrder,
  completeDelivery,
  getPendingOfferForDriver,
} from '../services/order/index.js';
import { locationUpdateSchema } from '../shared/schemas.js';
import { sendError } from '../shared/errors.js';

const router = Router();

/**
 * Parses a location body, answering 422 itself when it is invalid.
 */
function parseLocation(req: Request, res: Response) {
  const parsed = locationUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(422).json({
      success: false,
      error: 'Location (lat, lng) is required and must be in range',
      code: 'LOCATION_INVALID',
    });
    return null;
  }
  return parsed.data;
}

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
    sendError(res, error, 'Failed to get driver profile');
  }
});

// Go online: offline -> available (a busy courier stays busy), then record the position
router.post('/go-online', authenticate, requireDriver, async (req: Request, res: Response) => {
  try {
    const location = parseLocation(req, res);
    if (!location) return;

    const driver = await goOnline(req.userId!);
    if (!driver) {
      res.status(404).json({ success: false, error: 'Driver profile not found' });
      return;
    }
    await updateDriverLocation(req.userId!, location.lat, location.lng);

    res.json({
      success: true,
      data: driver,
      message: 'You are now online',
    });
  } catch (error) {
    sendError(res, error, 'Failed to go online');
  }
});

// Go offline: refused while the courier holds an active delivery (checked in the same UPDATE)
router.post('/go-offline', authenticate, requireDriver, async (req: Request, res: Response) => {
  try {
    const result = await goOffline(req.userId!);

    if (result.status === 'has_active_orders') {
      res.status(409).json({
        success: false,
        error: 'Cannot go offline with active deliveries',
        code: 'ACTIVE_DELIVERIES',
      });
      return;
    }
    if (result.status === 'not_found') {
      res.status(404).json({ success: false, error: 'Driver profile not found' });
      return;
    }

    res.json({
      success: true,
      data: result.driver,
      message: 'You are now offline',
    });
  } catch (error) {
    sendError(res, error, 'Failed to go offline');
  }
});

// Update location: Redis on every ping, PostgreSQL at most every 10 s
router.post('/location', authenticate, requireDriver, async (req: Request, res: Response) => {
  try {
    const location = parseLocation(req, res);
    if (!location) return;

    const { persisted } = await updateDriverLocation(req.userId!, location.lat, location.lng, {
      speed: location.speed,
      heading: location.heading,
    });

    res.json({
      success: true,
      data: { persisted },
      message: 'Location updated',
    });
  } catch (error) {
    sendError(res, error, 'Failed to update location');
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
    sendError(res, error, 'Failed to get orders');
  }
});

// Get pending offer (the app calls this on every (re)connect, so a missed push is recovered)
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
    sendError(res, error, 'Failed to get pending offer');
  }
});

/** Response for each way an Accept can fail; all are 409 Conflict. */
const ACCEPT_FAILURES = {
  offer_unavailable: { error: 'Offer expired or already answered', code: 'OFFER_UNAVAILABLE' },
  order_unavailable: { error: 'Order is no longer available', code: 'ORDER_UNAVAILABLE' },
  driver_offline: { error: 'Go online before accepting offers', code: 'DRIVER_OFFLINE' },
} as const;

// Accept offer: the atomic claim (offer, order and courier change in one transaction)
router.post('/offers/:id/accept', authenticate, requireDriver, async (req: Request, res: Response) => {
  try {
    const result = await acceptDriverOffer(req.params.id as string, req.userId!);

    if (result.status !== 'accepted') {
      res.status(409).json({ success: false, ...ACCEPT_FAILURES[result.status] });
      return;
    }

    const orderWithDetails = await getOrderWithDetails(result.order.id);

    res.json({
      success: true,
      data: orderWithDetails,
      message: 'Order accepted',
    });
  } catch (error) {
    sendError(res, error, 'Failed to accept offer');
  }
});

// Reject offer
router.post('/offers/:id/reject', authenticate, requireDriver, async (req: Request, res: Response) => {
  try {
    const success = await rejectDriverOffer(req.params.id as string, req.userId!);

    if (!success) {
      res.status(409).json({
        success: false,
        error: 'Offer not found or already answered',
        code: 'OFFER_UNAVAILABLE',
      });
      return;
    }

    res.json({
      success: true,
      message: 'Offer rejected',
    });
  } catch (error) {
    sendError(res, error, 'Failed to reject offer');
  }
});

// Mark order as picked up (only the assigned courier, only from driver_assigned)
router.post('/orders/:id/picked-up', authenticate, requireDriver, async (req: Request, res: Response) => {
  try {
    const order = await transitionOrder(req.params.id as string, 'picked_up', { driverId: req.userId! });
    res.json({
      success: true,
      data: order,
      message: 'Order marked as picked up',
    });
  } catch (error) {
    sendError(res, error, 'Failed to pickup order');
  }
});

// Mark order as in transit (only the assigned courier, only from picked_up)
router.post('/orders/:id/in-transit', authenticate, requireDriver, async (req: Request, res: Response) => {
  try {
    const order = await transitionOrder(req.params.id as string, 'in_transit', { driverId: req.userId! });
    res.json({
      success: true,
      data: order,
      message: 'Order in transit',
    });
  } catch (error) {
    sendError(res, error, 'Failed to update order');
  }
});

// Mark order as delivered (order, courier stats and availability commit together)
router.post('/orders/:id/delivered', authenticate, requireDriver, async (req: Request, res: Response) => {
  try {
    const order = await completeDelivery(req.params.id as string, req.userId!);
    res.json({
      success: true,
      data: order,
      message: 'Order delivered successfully',
    });
  } catch (error) {
    sendError(res, error, 'Failed to deliver order');
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
    sendError(res, error, 'Failed to get stats');
  }
});

export default router;
