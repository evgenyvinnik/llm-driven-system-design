import { Router } from 'express';
import { query } from '../db.js';
import redisClient from '../redis.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { getDriverByUserId } from '../services/auth.js';
import { haversineDistance, calculateETA } from '../utils/geo.js';
import { broadcast, broadcastToChannels } from '../websocket.js';

const router = Router();

const LOCATION_TTL = 300; // 5 minutes TTL for location data

// Update driver location
router.post('/location', requireAuth, async (req, res) => {
  try {
    const { lat, lon } = req.body;

    if (lat === undefined || lon === undefined) {
      return res.status(400).json({ error: 'lat and lon are required' });
    }

    // Get driver profile
    const driver = await getDriverByUserId(req.user.id);
    if (!driver) {
      return res.status(403).json({ error: 'Not registered as driver' });
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

    // Broadcast location to subscribers (customers tracking their orders)
    const activeOrders = await query(
      `SELECT id, customer_id FROM orders WHERE driver_id = $1 AND status IN ('CONFIRMED', 'PREPARING', 'READY_FOR_PICKUP', 'PICKED_UP')`,
      [driver.id]
    );

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
    console.error('Update location error:', err);
    res.status(500).json({ error: 'Failed to update location' });
  }
});

// Toggle driver active status (go online/offline)
router.post('/status', requireAuth, async (req, res) => {
  try {
    const { isActive } = req.body;

    const driver = await getDriverByUserId(req.user.id);
    if (!driver) {
      return res.status(403).json({ error: 'Not registered as driver' });
    }

    await query(`UPDATE drivers SET is_active = $1, is_available = $1, updated_at = NOW() WHERE id = $2`, [
      isActive,
      driver.id,
    ]);

    if (!isActive) {
      // Remove from geo index when going offline
      await redisClient.zRem('driver_locations', driver.id.toString());
      await redisClient.del(`driver:${driver.id}`);
    }

    res.json({ isActive });
  } catch (err) {
    console.error('Update status error:', err);
    res.status(500).json({ error: 'Failed to update status' });
  }
});

// Get driver's current orders
router.get('/orders', requireAuth, async (req, res) => {
  try {
    const driver = await getDriverByUserId(req.user.id);
    if (!driver) {
      return res.status(403).json({ error: 'Not registered as driver' });
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
      result.rows.map(async (order) => {
        const itemsResult = await query('SELECT * FROM order_items WHERE order_id = $1', [order.id]);
        return { ...order, items: itemsResult.rows };
      })
    );

    res.json({ orders });
  } catch (err) {
    console.error('Get driver orders error:', err);
    res.status(500).json({ error: 'Failed to get orders' });
  }
});

// Driver picks up order
router.post('/orders/:orderId/pickup', requireAuth, async (req, res) => {
  try {
    const { orderId } = req.params;

    const driver = await getDriverByUserId(req.user.id);
    if (!driver) {
      return res.status(403).json({ error: 'Not registered as driver' });
    }

    // Check order
    const orderResult = await query(
      `SELECT * FROM orders WHERE id = $1 AND driver_id = $2`,
      [orderId, driver.id]
    );

    if (orderResult.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found or not assigned to you' });
    }

    const order = orderResult.rows[0];

    if (order.status !== 'READY_FOR_PICKUP') {
      return res.status(400).json({ error: `Cannot pickup order in ${order.status} status` });
    }

    // Update status
    await query(
      `UPDATE orders SET status = 'PICKED_UP', picked_up_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [orderId]
    );

    // Get updated order with details
    const updatedOrder = await getOrderWithDetails(orderId);

    // Recalculate ETA
    const eta = calculateETA(updatedOrder, driver, updatedOrder.restaurant);
    await query('UPDATE orders SET estimated_delivery_at = $1 WHERE id = $2', [eta.eta, orderId]);

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
    console.error('Pickup order error:', err);
    res.status(500).json({ error: 'Failed to pickup order' });
  }
});

// Driver delivers order
router.post('/orders/:orderId/deliver', requireAuth, async (req, res) => {
  try {
    const { orderId } = req.params;

    const driver = await getDriverByUserId(req.user.id);
    if (!driver) {
      return res.status(403).json({ error: 'Not registered as driver' });
    }

    // Check order
    const orderResult = await query(`SELECT * FROM orders WHERE id = $1 AND driver_id = $2`, [orderId, driver.id]);

    if (orderResult.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found or not assigned to you' });
    }

    const order = orderResult.rows[0];

    if (order.status !== 'PICKED_UP') {
      return res.status(400).json({ error: `Cannot deliver order in ${order.status} status` });
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

    // Get updated order
    const updatedOrder = await getOrderWithDetails(orderId);

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
    console.error('Deliver order error:', err);
    res.status(500).json({ error: 'Failed to deliver order' });
  }
});

// Get driver stats
router.get('/stats', requireAuth, async (req, res) => {
  try {
    const driver = await getDriverByUserId(req.user.id);
    if (!driver) {
      return res.status(403).json({ error: 'Not registered as driver' });
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
    console.error('Get driver stats error:', err);
    res.status(500).json({ error: 'Failed to get stats' });
  }
});

// Helper: Get order with details
async function getOrderWithDetails(orderId) {
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

  return order;
}

export default router;
