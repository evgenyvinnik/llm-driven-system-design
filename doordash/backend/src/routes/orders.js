import { Router } from 'express';
import { query } from '../db.js';
import redisClient from '../redis.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { haversineDistance, calculateETA } from '../utils/geo.js';
import { broadcast, broadcastToChannels } from '../websocket.js';

const router = Router();

const TAX_RATE = 0.0875; // 8.75% tax

// Order status flow
const ORDER_TRANSITIONS = {
  PLACED: { next: ['CONFIRMED', 'CANCELLED'], actor: 'restaurant' },
  CONFIRMED: { next: ['PREPARING', 'CANCELLED'], actor: 'restaurant' },
  PREPARING: { next: ['READY_FOR_PICKUP'], actor: 'restaurant' },
  READY_FOR_PICKUP: { next: ['PICKED_UP'], actor: 'driver' },
  PICKED_UP: { next: ['DELIVERED'], actor: 'driver' },
  DELIVERED: { next: ['COMPLETED'], actor: 'system' },
  COMPLETED: { next: [], actor: null },
  CANCELLED: { next: [], actor: null },
};

// Place a new order
router.post('/', requireAuth, async (req, res) => {
  try {
    const { restaurantId, items, deliveryAddress, deliveryInstructions, tip = 0 } = req.body;

    if (!restaurantId || !items || !items.length || !deliveryAddress) {
      return res.status(400).json({ error: 'Restaurant, items, and delivery address are required' });
    }

    if (!deliveryAddress.lat || !deliveryAddress.lon || !deliveryAddress.address) {
      return res.status(400).json({ error: 'Delivery address must include lat, lon, and address' });
    }

    // Get restaurant
    const restaurantResult = await query('SELECT * FROM restaurants WHERE id = $1', [restaurantId]);
    if (restaurantResult.rows.length === 0) {
      return res.status(404).json({ error: 'Restaurant not found' });
    }
    const restaurant = restaurantResult.rows[0];

    // Get menu items
    const itemIds = items.map((i) => i.menuItemId);
    const menuResult = await query(
      `SELECT id, name, price, is_available FROM menu_items
       WHERE id = ANY($1) AND restaurant_id = $2`,
      [itemIds, restaurantId]
    );

    const menuItems = new Map(menuResult.rows.map((i) => [i.id, i]));

    // Validate all items exist and are available
    let subtotal = 0;
    const orderItems = [];
    for (const item of items) {
      const menuItem = menuItems.get(item.menuItemId);
      if (!menuItem) {
        return res.status(400).json({ error: `Menu item ${item.menuItemId} not found` });
      }
      if (!menuItem.is_available) {
        return res.status(400).json({ error: `${menuItem.name} is not available` });
      }

      const quantity = item.quantity || 1;
      subtotal += parseFloat(menuItem.price) * quantity;
      orderItems.push({
        menuItemId: menuItem.id,
        name: menuItem.name,
        price: menuItem.price,
        quantity,
        specialInstructions: item.specialInstructions,
      });
    }

    // Check minimum order
    if (subtotal < parseFloat(restaurant.min_order)) {
      return res.status(400).json({
        error: `Minimum order is $${restaurant.min_order}`,
      });
    }

    const deliveryFee = parseFloat(restaurant.delivery_fee);
    const tax = subtotal * TAX_RATE;
    const total = subtotal + deliveryFee + tax + parseFloat(tip);

    // Create order
    const orderResult = await query(
      `INSERT INTO orders (customer_id, restaurant_id, subtotal, delivery_fee, tax, tip, total, delivery_address, delivery_instructions)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        req.user.id,
        restaurantId,
        subtotal.toFixed(2),
        deliveryFee.toFixed(2),
        tax.toFixed(2),
        parseFloat(tip).toFixed(2),
        total.toFixed(2),
        JSON.stringify(deliveryAddress),
        deliveryInstructions,
      ]
    );

    const order = orderResult.rows[0];

    // Insert order items
    for (const item of orderItems) {
      await query(
        `INSERT INTO order_items (order_id, menu_item_id, name, price, quantity, special_instructions)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [order.id, item.menuItemId, item.name, item.price, item.quantity, item.specialInstructions]
      );
    }

    // Get full order details
    const fullOrder = await getOrderWithDetails(order.id);

    // Notify restaurant via WebSocket
    broadcast(`restaurant:${restaurantId}:orders`, {
      type: 'new_order',
      order: fullOrder,
    });

    res.status(201).json({ order: fullOrder });
  } catch (err) {
    console.error('Place order error:', err);
    res.status(500).json({ error: 'Failed to place order' });
  }
});

// Get order by ID
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const order = await getOrderWithDetails(id);

    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    // Check authorization
    const isCustomer = order.customer_id === req.user.id;
    const isRestaurantOwner = order.restaurant?.owner_id === req.user.id;
    const isDriver = order.driver?.user_id === req.user.id;
    const isAdmin = req.user.role === 'admin';

    if (!isCustomer && !isRestaurantOwner && !isDriver && !isAdmin) {
      return res.status(403).json({ error: 'Not authorized to view this order' });
    }

    res.json({ order });
  } catch (err) {
    console.error('Get order error:', err);
    res.status(500).json({ error: 'Failed to get order' });
  }
});

// Get customer's orders
router.get('/', requireAuth, async (req, res) => {
  try {
    const { status, limit = 20, offset = 0 } = req.query;

    let sql = `
      SELECT o.*, r.name as restaurant_name, r.image_url as restaurant_image
      FROM orders o
      JOIN restaurants r ON o.restaurant_id = r.id
      WHERE o.customer_id = $1
    `;
    const params = [req.user.id];

    if (status) {
      params.push(status);
      sql += ` AND o.status = $${params.length}`;
    }

    sql += ' ORDER BY o.placed_at DESC LIMIT $' + (params.length + 1) + ' OFFSET $' + (params.length + 2);
    params.push(parseInt(limit), parseInt(offset));

    const result = await query(sql, params);

    res.json({ orders: result.rows });
  } catch (err) {
    console.error('Get orders error:', err);
    res.status(500).json({ error: 'Failed to get orders' });
  }
});

// Update order status
router.patch('/:id/status', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { status, cancelReason } = req.body;

    const order = await getOrderWithDetails(id);
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    // Validate transition
    const currentTransition = ORDER_TRANSITIONS[order.status];
    if (!currentTransition.next.includes(status)) {
      return res.status(400).json({
        error: `Cannot transition from ${order.status} to ${status}`,
      });
    }

    // Check authorization based on actor
    const isCustomer = order.customer_id === req.user.id;
    const isRestaurantOwner = order.restaurant?.owner_id === req.user.id;
    const isDriver = order.driver?.user_id === req.user.id;
    const isAdmin = req.user.role === 'admin';

    // Special case: customer can cancel only in PLACED status
    if (status === 'CANCELLED') {
      if (order.status === 'PLACED' && isCustomer) {
        // OK
      } else if (isRestaurantOwner || isAdmin) {
        // Restaurant can cancel
      } else {
        return res.status(403).json({ error: 'Not authorized to cancel this order' });
      }
    } else {
      // Check actor
      if (currentTransition.actor === 'restaurant' && !isRestaurantOwner && !isAdmin) {
        return res.status(403).json({ error: 'Only restaurant can update this status' });
      }
      if (currentTransition.actor === 'driver' && !isDriver && !isAdmin) {
        return res.status(403).json({ error: 'Only driver can update this status' });
      }
    }

    // Update status
    const updateFields = [`status = $2`, `updated_at = NOW()`];
    const params = [id, status];

    // Set timestamp based on status
    const timestampFields = {
      CONFIRMED: 'confirmed_at',
      PREPARING: 'preparing_at',
      READY_FOR_PICKUP: 'ready_at',
      PICKED_UP: 'picked_up_at',
      DELIVERED: 'delivered_at',
      CANCELLED: 'cancelled_at',
    };

    if (timestampFields[status]) {
      updateFields.push(`${timestampFields[status]} = NOW()`);
    }

    if (status === 'CANCELLED' && cancelReason) {
      params.push(cancelReason);
      updateFields.push(`cancel_reason = $${params.length}`);
    }

    await query(`UPDATE orders SET ${updateFields.join(', ')} WHERE id = $1`, params);

    // If confirmed, start driver matching
    if (status === 'CONFIRMED') {
      await matchDriverToOrder(id);
    }

    // Get updated order
    const updatedOrder = await getOrderWithDetails(id);

    // Calculate ETA if driver assigned
    let eta = null;
    if (updatedOrder.driver && !['DELIVERED', 'COMPLETED', 'CANCELLED'].includes(status)) {
      eta = calculateETA(updatedOrder, updatedOrder.driver, updatedOrder.restaurant);
      await query('UPDATE orders SET estimated_delivery_at = $1 WHERE id = $2', [eta.eta, id]);
      updatedOrder.estimated_delivery_at = eta.eta;
      updatedOrder.eta_breakdown = eta.breakdown;
    }

    // Broadcast to all relevant parties
    broadcastToChannels(
      [`order:${id}`, `customer:${order.customer_id}:orders`, `restaurant:${order.restaurant_id}:orders`],
      {
        type: 'order_status_update',
        order: updatedOrder,
        eta,
      }
    );

    res.json({ order: updatedOrder, eta });
  } catch (err) {
    console.error('Update order status error:', err);
    res.status(500).json({ error: 'Failed to update order status' });
  }
});

// Restaurant: Get incoming orders
router.get('/restaurant/:restaurantId', requireAuth, requireRole('restaurant_owner', 'admin'), async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { status, limit = 50 } = req.query;

    // Check ownership
    const restaurant = await query('SELECT owner_id FROM restaurants WHERE id = $1', [restaurantId]);
    if (restaurant.rows.length === 0) {
      return res.status(404).json({ error: 'Restaurant not found' });
    }
    if (restaurant.rows[0].owner_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Not authorized' });
    }

    let sql = `
      SELECT o.*, u.name as customer_name, u.phone as customer_phone
      FROM orders o
      JOIN users u ON o.customer_id = u.id
      WHERE o.restaurant_id = $1
    `;
    const params = [restaurantId];

    if (status) {
      if (status === 'active') {
        sql += ` AND o.status NOT IN ('DELIVERED', 'COMPLETED', 'CANCELLED')`;
      } else {
        params.push(status);
        sql += ` AND o.status = $${params.length}`;
      }
    }

    sql += ' ORDER BY o.placed_at DESC LIMIT $' + (params.length + 1);
    params.push(parseInt(limit));

    const result = await query(sql, params);

    // Get items for each order
    const orders = await Promise.all(
      result.rows.map(async (order) => {
        const itemsResult = await query('SELECT * FROM order_items WHERE order_id = $1', [order.id]);
        return { ...order, items: itemsResult.rows };
      })
    );

    res.json({ orders });
  } catch (err) {
    console.error('Get restaurant orders error:', err);
    res.status(500).json({ error: 'Failed to get orders' });
  }
});

// Helper: Get order with full details
async function getOrderWithDetails(orderId) {
  const orderResult = await query(
    `SELECT o.*,
            r.name as restaurant_name, r.address as restaurant_address,
            r.lat as restaurant_lat, r.lon as restaurant_lon,
            r.prep_time_minutes, r.image_url as restaurant_image, r.owner_id as restaurant_owner_id
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

  // Get driver if assigned
  if (order.driver_id) {
    const driverResult = await query(
      `SELECT d.*, u.name, u.phone
       FROM drivers d
       JOIN users u ON d.user_id = u.id
       WHERE d.id = $1`,
      [order.driver_id]
    );
    if (driverResult.rows.length > 0) {
      order.driver = driverResult.rows[0];
    }
  }

  // Format restaurant info
  order.restaurant = {
    id: order.restaurant_id,
    name: order.restaurant_name,
    address: order.restaurant_address,
    lat: parseFloat(order.restaurant_lat),
    lon: parseFloat(order.restaurant_lon),
    prep_time_minutes: order.prep_time_minutes,
    image_url: order.restaurant_image,
    owner_id: order.restaurant_owner_id,
  };

  return order;
}

// Helper: Match a driver to an order
async function matchDriverToOrder(orderId) {
  const order = await getOrderWithDetails(orderId);
  if (!order || order.driver_id) {
    return; // Already has driver or order not found
  }

  // Find nearby available drivers using Redis geo
  const nearbyDrivers = await findNearbyDrivers(order.restaurant.lat, order.restaurant.lon, 5);

  if (nearbyDrivers.length === 0) {
    console.log(`No drivers available for order ${orderId}`);
    return;
  }

  // Score drivers
  const scoredDrivers = await Promise.all(
    nearbyDrivers.map(async (d) => {
      const driver = await query(
        `SELECT d.*, u.name FROM drivers d JOIN users u ON d.user_id = u.id WHERE d.id = $1`,
        [d.id]
      );
      if (driver.rows.length === 0) return null;

      const driverData = driver.rows[0];
      const score = calculateMatchScore(driverData, order, d.distance);
      return { driver: driverData, score, distance: d.distance };
    })
  );

  const validDrivers = scoredDrivers.filter((d) => d !== null).sort((a, b) => b.score - a.score);

  if (validDrivers.length === 0) {
    return;
  }

  // Assign best driver
  const bestMatch = validDrivers[0];
  await query(
    `UPDATE orders SET driver_id = $1, updated_at = NOW() WHERE id = $2`,
    [bestMatch.driver.id, orderId]
  );

  // Mark driver as unavailable
  await query(`UPDATE drivers SET is_available = false WHERE id = $1`, [bestMatch.driver.id]);

  // Calculate ETA
  const eta = calculateETA(order, bestMatch.driver, order.restaurant);
  await query('UPDATE orders SET estimated_delivery_at = $1 WHERE id = $2', [eta.eta, orderId]);

  // Notify driver
  broadcast(`driver:${bestMatch.driver.user_id}:orders`, {
    type: 'order_assigned',
    order: await getOrderWithDetails(orderId),
    eta,
  });

  console.log(`Assigned driver ${bestMatch.driver.id} to order ${orderId}`);
}

// Helper: Find nearby drivers using Redis geo
async function findNearbyDrivers(lat, lon, radiusKm) {
  try {
    // Use Redis GEOSEARCH
    const results = await redisClient.geoSearch('driver_locations', { longitude: lon, latitude: lat }, {
      radius: radiusKm,
      unit: 'km',
    }, {
      WITHDIST: true,
      SORT: 'ASC',
      COUNT: 20,
    });

    // Filter by availability from database
    const availableDrivers = [];
    for (const result of results) {
      const driverId = parseInt(result.member);
      const check = await query(
        'SELECT id FROM drivers WHERE id = $1 AND is_active = true AND is_available = true',
        [driverId]
      );
      if (check.rows.length > 0) {
        availableDrivers.push({
          id: driverId,
          distance: result.distance,
        });
      }
    }

    return availableDrivers;
  } catch (err) {
    console.error('Find nearby drivers error:', err);
    // Fallback to database query
    const result = await query(
      `SELECT id, current_lat, current_lon FROM drivers
       WHERE is_active = true AND is_available = true
       AND current_lat IS NOT NULL AND current_lon IS NOT NULL`
    );

    return result.rows
      .map((d) => ({
        id: d.id,
        distance: haversineDistance(lat, lon, parseFloat(d.current_lat), parseFloat(d.current_lon)),
      }))
      .filter((d) => d.distance <= radiusKm)
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 20);
  }
}

// Helper: Calculate match score for driver
function calculateMatchScore(driver, order, distance) {
  let score = 0;

  // Distance to restaurant (most important) - closer is better
  score += 100 - distance * 10;

  // Driver rating
  score += parseFloat(driver.rating || 5) * 5;

  // Experience (more deliveries = more reliable)
  score += Math.min(driver.total_deliveries / 10, 20);

  return score;
}

export default router;
