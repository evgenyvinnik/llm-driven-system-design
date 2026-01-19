import { Router, Request, Response } from 'express';
import { query } from '../db.js';
import redisClient from '../redis.js';
import { requireAuth } from '../middleware/auth.js';
import { getDriverByUserId, Driver } from '../services/auth.js';
import { calculateETA, ETAResult } from '../utils/geo.js';
import { broadcast, broadcastToChannels } from '../websocket.js';

// Shared modules
import logger from '../shared/logger.js';
import {
  driversActive,
  driversAvailable,
  driverLocationUpdates,
  deliveryDuration,
  etaAccuracy,
} from '../shared/metrics.js';
import { auditOrderStatusChange, ACTOR_TYPES } from '../shared/audit.js';
import { publishOrderEvent, publishLocationUpdate } from '../shared/kafka.js';

const router = Router();

const LOCATION_TTL = 300; // 5 minutes TTL for location data

interface OrderWithDetails {
  id: number;
  customer_id: number;
  restaurant_id: number;
  driver_id?: number | null;
  status: string;
  placed_at?: string;
  estimated_delivery_at?: string;
  delivery_address: {
    lat: number;
    lon: number;
    address: string;
  };
  items?: unknown[];
  restaurant?: {
    id: number;
    name: string;
    address: string;
    lat: number;
    lon: number;
    prep_time_minutes?: number;
    owner_id?: number;
  };
}

// Update driver location
router.post('/location', requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const { lat, lon } = req.body;

    if (lat === undefined || lon === undefined) {
      res.status(400).json({ error: 'lat and lon are required' });
      return;
    }

    // Get driver profile
    const driver = await getDriverByUserId(req.user!.id);
    if (!driver) {
      res.status(403).json({ error: 'Not registered as driver' });
      return;
    }

    // Update in PostgreSQL
    await query(
      `UPDATE drivers SET current_lat = $1, current_lon = $2, updated_at = NOW() WHERE id = $3`,
      [lat, lon, driver.id]
    );

    // Update in Redis for geo queries
    await redisClient.geoAdd('driver_locations', {
      longitude: lon,
      latitude: lat,
      member: driver.id.toString(),
    });

    // Set expiry on driver hash
    await redisClient.hSet(`driver:${driver.id}`, {
      lat: lat.toString(),
      lon: lon.toString(),
      updated_at: Date.now().toString(),
    });
    await redisClient.expire(`driver:${driver.id}`, LOCATION_TTL);

    // Record metric
    driverLocationUpdates.inc();

    // Publish location update to Kafka (for analytics and tracking)
    const activeOrders = await query(
      `SELECT id, customer_id FROM orders WHERE driver_id = $1 AND status IN ('CONFIRMED', 'PREPARING', 'READY_FOR_PICKUP', 'PICKED_UP')`,
      [driver.id]
    );

    // If driver has active orders, include the order ID in the Kafka event
    const activeOrderId = activeOrders.rows.length > 0 ? activeOrders.rows[0].id.toString() : null;
    publishLocationUpdate(driver.id.toString(), lat, lon, activeOrderId);

    // Broadcast location to subscribers (customers tracking their orders)
    for (const order of activeOrders.rows) {
      broadcast(`order:${order.id}`, {
        type: 'driver_location',
        driverId: driver.id,
        lat,
        lon,
        timestamp: Date.now(),
      });
    }

    res.json({ success: true });
  } catch (err) {
    const error = err as Error;
    logger.error({ error: error.message }, 'Update location error');
    res.status(500).json({ error: 'Failed to update location' });
  }
});

// Toggle driver active status (go online/offline)
router.post('/status', requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const { isActive } = req.body;

    const driver = await getDriverByUserId(req.user!.id);
    if (!driver) {
      res.status(403).json({ error: 'Not registered as driver' });
      return;
    }

    const wasActive = driver.is_active;

    await query(`UPDATE drivers SET is_active = $1, is_available = $1, updated_at = NOW() WHERE id = $2`, [
      isActive,
      driver.id,
    ]);

    // Update metrics
    if (isActive && !wasActive) {
      driversActive.inc();
      driversAvailable.inc();
    } else if (!isActive && wasActive) {
      driversActive.dec();
      driversAvailable.dec();
    }

    if (!isActive) {
      // Remove from geo index when going offline
      await redisClient.zRem('driver_locations', driver.id.toString());
      await redisClient.del(`driver:${driver.id}`);
    }

    logger.info({ driverId: driver.id, isActive }, 'Driver status changed');

    res.json({ isActive });
  } catch (err) {
    const error = err as Error;
    logger.error({ error: error.message }, 'Update status error');
    res.status(500).json({ error: 'Failed to update status' });
  }
});

// Get driver's current orders
router.get('/orders', requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const driver = await getDriverByUserId(req.user!.id);
    if (!driver) {
      res.status(403).json({ error: 'Not registered as driver' });
      return;
    }

    const { status = 'active' } = req.query;

    let sql = `
      SELECT o.*,
             r.name as restaurant_name, r.address as restaurant_address,
             r.lat as restaurant_lat, r.lon as restaurant_lon,
             u.name as customer_name, u.phone as customer_phone
      FROM orders o
      JOIN restaurants r ON o.restaurant_id = r.id
      JOIN users u ON o.customer_id = u.id
      WHERE o.driver_id = $1
    `;

    if (status === 'active') {
      sql += ` AND o.status IN ('CONFIRMED', 'PREPARING', 'READY_FOR_PICKUP', 'PICKED_UP')`;
    } else if (status === 'completed') {
      sql += ` AND o.status IN ('DELIVERED', 'COMPLETED')`;
    }

    sql += ' ORDER BY o.placed_at DESC';

    const result = await query(sql, [driver.id]);

    // Get items for each order
    const orders = await Promise.all(
      result.rows.map(async (order: { id: number }) => {
        const itemsResult = await query('SELECT * FROM order_items WHERE order_id = $1', [order.id]);
        return { ...order, items: itemsResult.rows };
      })
    );

    res.json({ orders });
  } catch (err) {
    const error = err as Error;
    logger.error({ error: error.message }, 'Get driver orders error');
    res.status(500).json({ error: 'Failed to get orders' });
  }
});

// Driver picks up order
router.post('/orders/:orderId/pickup', requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const { orderId } = req.params;

    const driver = await getDriverByUserId(req.user!.id);
    if (!driver) {
      res.status(403).json({ error: 'Not registered as driver' });
      return;
    }

    // Check order
    const orderResult = await query(`SELECT * FROM orders WHERE id = $1 AND driver_id = $2`, [
      orderId,
      driver.id,
    ]);

    if (orderResult.rows.length === 0) {
      res.status(404).json({ error: 'Order not found or not assigned to you' });
      return;
    }

    const order = orderResult.rows[0];
    const previousStatus = order.status;

    if (order.status !== 'READY_FOR_PICKUP') {
      res.status(400).json({ error: `Cannot pickup order in ${order.status} status` });
      return;
    }

    // Update status
    await query(
      `UPDATE orders SET status = 'PICKED_UP', picked_up_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [orderId]
    );

    // Create audit log
    await auditOrderStatusChange(
      order,
      previousStatus,
      'PICKED_UP',
      { type: ACTOR_TYPES.DRIVER, id: req.user!.id },
      { ip: req.ip, userAgent: req.get('User-Agent') }
    );

    // Get updated order with details
    const updatedOrder = await getOrderWithDetails(parseInt(orderId));

    // Recalculate ETA
    const eta = calculateETA(
      {
        status: updatedOrder!.status,
        delivery_address: updatedOrder!.delivery_address,
      },
      {
        current_lat: driver.current_lat!,
        current_lon: driver.current_lon!,
      },
      {
        lat: updatedOrder!.restaurant!.lat,
        lon: updatedOrder!.restaurant!.lon,
        prep_time_minutes: updatedOrder!.restaurant!.prep_time_minutes,
      }
    );
    await query('UPDATE orders SET estimated_delivery_at = $1 WHERE id = $2', [eta.eta, orderId]);

    logger.info({ orderId, driverId: driver.id }, 'Order picked up');

    // Publish order event to Kafka
    publishOrderEvent(orderId.toString(), 'picked_up', {
      driverId: driver.id,
      estimatedDelivery: eta.eta,
    });

    // Broadcast update
    broadcastToChannels(
      [`order:${orderId}`, `customer:${order.customer_id}:orders`, `restaurant:${order.restaurant_id}:orders`],
      {
        type: 'order_status_update',
        order: updatedOrder,
        eta,
      }
    );

    res.json({ order: updatedOrder, eta });
  } catch (err) {
    const error = err as Error;
    logger.error({ error: error.message, orderId: req.params.orderId }, 'Pickup order error');
    res.status(500).json({ error: 'Failed to pickup order' });
  }
});

// Driver delivers order
router.post('/orders/:orderId/deliver', requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const { orderId } = req.params;

    const driver = await getDriverByUserId(req.user!.id);
    if (!driver) {
      res.status(403).json({ error: 'Not registered as driver' });
      return;
    }

    // Check order
    const orderResult = await query(`SELECT * FROM orders WHERE id = $1 AND driver_id = $2`, [orderId, driver.id]);

    if (orderResult.rows.length === 0) {
      res.status(404).json({ error: 'Order not found or not assigned to you' });
      return;
    }

    const order = orderResult.rows[0];
    const previousStatus = order.status;

    if (order.status !== 'PICKED_UP') {
      res.status(400).json({ error: `Cannot deliver order in ${order.status} status` });
      return;
    }

    // Update order status
    await query(
      `UPDATE orders SET status = 'DELIVERED', delivered_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [orderId]
    );

    // Mark driver as available again
    await query(`UPDATE drivers SET is_available = true, total_deliveries = total_deliveries + 1 WHERE id = $1`, [
      driver.id,
    ]);

    // Update metrics
    driversAvailable.inc();

    // Record delivery time
    if (order.placed_at) {
      const deliveryTimeMinutes = (Date.now() - new Date(order.placed_at).getTime()) / 60000;
      deliveryDuration.observe(deliveryTimeMinutes);

      // Calculate ETA accuracy if we had an estimate
      if (order.estimated_delivery_at) {
        const estimatedTime = new Date(order.estimated_delivery_at).getTime();
        const actualTime = Date.now();
        const diffMinutes = (actualTime - estimatedTime) / 60000;
        etaAccuracy.observe(diffMinutes);
      }
    }

    // Create audit log
    await auditOrderStatusChange(
      order,
      previousStatus,
      'DELIVERED',
      { type: ACTOR_TYPES.DRIVER, id: req.user!.id },
      { ip: req.ip, userAgent: req.get('User-Agent') }
    );

    // Get updated order
    const updatedOrder = await getOrderWithDetails(parseInt(orderId));

    logger.info(
      {
        orderId,
        driverId: driver.id,
        deliveryTimeMinutes: order.placed_at
          ? Math.round((Date.now() - new Date(order.placed_at).getTime()) / 60000)
          : null,
      },
      'Order delivered'
    );

    // Publish order event to Kafka
    publishOrderEvent(orderId.toString(), 'delivered', {
      driverId: driver.id,
      deliveryTimeMinutes: order.placed_at
        ? Math.round((Date.now() - new Date(order.placed_at).getTime()) / 60000)
        : null,
    });

    // Broadcast update
    broadcastToChannels(
      [`order:${orderId}`, `customer:${order.customer_id}:orders`, `restaurant:${order.restaurant_id}:orders`],
      {
        type: 'order_status_update',
        order: updatedOrder,
      }
    );

    res.json({ order: updatedOrder });
  } catch (err) {
    const error = err as Error;
    logger.error({ error: error.message, orderId: req.params.orderId }, 'Deliver order error');
    res.status(500).json({ error: 'Failed to deliver order' });
  }
});

// Get driver stats
router.get('/stats', requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const driver = await getDriverByUserId(req.user!.id);
    if (!driver) {
      res.status(403).json({ error: 'Not registered as driver' });
      return;
    }

    // Today's stats
    const todayResult = await query(
      `SELECT COUNT(*) as deliveries_today,
              SUM(tip) as tips_today,
              SUM(delivery_fee) as fees_today
       FROM orders
       WHERE driver_id = $1 AND status = 'DELIVERED' AND delivered_at >= CURRENT_DATE`,
      [driver.id]
    );

    // Active orders count
    const activeResult = await query(
      `SELECT COUNT(*) as active_orders FROM orders
       WHERE driver_id = $1 AND status IN ('CONFIRMED', 'PREPARING', 'READY_FOR_PICKUP', 'PICKED_UP')`,
      [driver.id]
    );

    res.json({
      driver: {
        id: driver.id,
        name: driver.name,
        vehicleType: driver.vehicle_type,
        rating: driver.rating,
        totalDeliveries: driver.total_deliveries,
        isActive: driver.is_active,
        isAvailable: driver.is_available,
      },
      today: {
        deliveries: parseInt(todayResult.rows[0].deliveries_today) || 0,
        tips: parseFloat(todayResult.rows[0].tips_today) || 0,
        fees: parseFloat(todayResult.rows[0].fees_today) || 0,
      },
      activeOrders: parseInt(activeResult.rows[0].active_orders) || 0,
    });
  } catch (err) {
    const error = err as Error;
    logger.error({ error: error.message }, 'Get driver stats error');
    res.status(500).json({ error: 'Failed to get stats' });
  }
});

// Helper: Get order with details
async function getOrderWithDetails(orderId: number): Promise<OrderWithDetails | null> {
  const orderResult = await query(
    `SELECT o.*,
            r.name as restaurant_name, r.address as restaurant_address,
            r.lat as restaurant_lat, r.lon as restaurant_lon,
            r.prep_time_minutes, r.owner_id as restaurant_owner_id
     FROM orders o
     JOIN restaurants r ON o.restaurant_id = r.id
     WHERE o.id = $1`,
    [orderId]
  );

  if (orderResult.rows.length === 0) {
    return null;
  }

  const order = orderResult.rows[0];

  // Get items
  const itemsResult = await query('SELECT * FROM order_items WHERE order_id = $1', [orderId]);
  order.items = itemsResult.rows;

  // Format restaurant info
  order.restaurant = {
    id: order.restaurant_id,
    name: order.restaurant_name,
    address: order.restaurant_address,
    lat: parseFloat(order.restaurant_lat),
    lon: parseFloat(order.restaurant_lon),
    prep_time_minutes: order.prep_time_minutes,
    owner_id: order.restaurant_owner_id,
  };

  return order as OrderWithDetails;
}

export default router;
