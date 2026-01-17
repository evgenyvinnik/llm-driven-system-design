import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { haversineDistance } from '../utils/geo.js';

// Shared modules
import logger from '../shared/logger.js';
import {
  getCachedRestaurantWithMenu,
  setCachedRestaurantWithMenu,
  invalidateRestaurantCache,
  invalidateMenuCache,
  getCachedCuisines,
  setCachedCuisines,
} from '../shared/cache.js';

const router = Router();

// Get all restaurants (with optional filters)
router.get('/', async (req, res) => {
  try {
    const { cuisine, search, lat, lon, radius = 10 } = req.query;

    let sql = `
      SELECT id, name, description, address, lat, lon, cuisine_type,
             rating, rating_count, prep_time_minutes, is_open,
             image_url, delivery_fee, min_order
      FROM restaurants
      WHERE is_open = true
    `;
    const params = [];

    if (cuisine) {
      params.push(cuisine);
      sql += ` AND cuisine_type = $${params.length}`;
    }

    if (search) {
      params.push(`%${search}%`);
      sql += ` AND (name ILIKE $${params.length} OR description ILIKE $${params.length})`;
    }

    sql += ' ORDER BY rating DESC, rating_count DESC';

    const result = await query(sql, params);
    let restaurants = result.rows;

    // If location provided, filter by distance and add distance field
    if (lat && lon) {
      const userLat = parseFloat(lat);
      const userLon = parseFloat(lon);
      const radiusKm = parseFloat(radius);

      restaurants = restaurants
        .map((r) => ({
          ...r,
          distance: haversineDistance(userLat, userLon, parseFloat(r.lat), parseFloat(r.lon)),
        }))
        .filter((r) => r.distance <= radiusKm)
        .sort((a, b) => a.distance - b.distance);
    }

    res.json({ restaurants });
  } catch (err) {
    logger.error({ error: err.message }, 'Get restaurants error');
    res.status(500).json({ error: 'Failed to get restaurants' });
  }
});

// Get single restaurant with menu (with caching)
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    // Try cache first
    const cached = await getCachedRestaurantWithMenu(id);
    if (cached) {
      return res.json(cached);
    }

    // Cache miss - fetch from database
    const restaurantResult = await query(
      `SELECT id, name, description, address, lat, lon, cuisine_type,
              rating, rating_count, prep_time_minutes, is_open,
              image_url, delivery_fee, min_order
       FROM restaurants WHERE id = $1`,
      [id]
    );

    if (restaurantResult.rows.length === 0) {
      return res.status(404).json({ error: 'Restaurant not found' });
    }

    const restaurant = restaurantResult.rows[0];

    // Get menu items grouped by category
    const menuResult = await query(
      `SELECT id, name, description, price, category, image_url, is_available
       FROM menu_items
       WHERE restaurant_id = $1 AND is_available = true
       ORDER BY category, name`,
      [id]
    );

    // Group by category
    const menuByCategory = {};
    for (const item of menuResult.rows) {
      if (!menuByCategory[item.category]) {
        menuByCategory[item.category] = [];
      }
      menuByCategory[item.category].push(item);
    }

    const responseData = {
      restaurant,
      menu: menuByCategory,
    };

    // Store in cache
    await setCachedRestaurantWithMenu(id, restaurant, menuByCategory);

    res.json(responseData);
  } catch (err) {
    logger.error({ error: err.message, restaurantId: req.params.id }, 'Get restaurant error');
    res.status(500).json({ error: 'Failed to get restaurant' });
  }
});

// Get cuisine types (with caching)
router.get('/meta/cuisines', async (req, res) => {
  try {
    // Try cache first
    const cached = await getCachedCuisines();
    if (cached) {
      return res.json({ cuisines: cached });
    }

    // Cache miss
    const result = await query(
      `SELECT DISTINCT cuisine_type FROM restaurants WHERE cuisine_type IS NOT NULL ORDER BY cuisine_type`
    );

    const cuisines = result.rows.map((r) => r.cuisine_type);

    // Store in cache
    await setCachedCuisines(cuisines);

    res.json({ cuisines });
  } catch (err) {
    logger.error({ error: err.message }, 'Get cuisines error');
    res.status(500).json({ error: 'Failed to get cuisines' });
  }
});

// Restaurant owner routes

// Get my restaurants (for restaurant owners)
router.get('/owner/my-restaurants', requireAuth, requireRole('restaurant_owner', 'admin'), async (req, res) => {
  try {
    const result = await query(
      `SELECT * FROM restaurants WHERE owner_id = $1 ORDER BY name`,
      [req.user.id]
    );
    res.json({ restaurants: result.rows });
  } catch (err) {
    logger.error({ error: err.message }, 'Get my restaurants error');
    res.status(500).json({ error: 'Failed to get restaurants' });
  }
});

// Create restaurant
router.post('/', requireAuth, requireRole('restaurant_owner', 'admin'), async (req, res) => {
  try {
    const {
      name,
      description,
      address,
      lat,
      lon,
      cuisineType,
      prepTimeMinutes = 20,
      deliveryFee = 2.99,
      minOrder = 10.0,
    } = req.body;

    if (!name || !address || !lat || !lon) {
      return res.status(400).json({ error: 'Name, address, and location are required' });
    }

    const result = await query(
      `INSERT INTO restaurants (owner_id, name, description, address, lat, lon, cuisine_type, prep_time_minutes, delivery_fee, min_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [req.user.id, name, description, address, lat, lon, cuisineType, prepTimeMinutes, deliveryFee, minOrder]
    );

    logger.info({ restaurantId: result.rows[0].id, ownerId: req.user.id }, 'Restaurant created');

    res.status(201).json({ restaurant: result.rows[0] });
  } catch (err) {
    logger.error({ error: err.message }, 'Create restaurant error');
    res.status(500).json({ error: 'Failed to create restaurant' });
  }
});

// Update restaurant (with cache invalidation)
router.put('/:id', requireAuth, requireRole('restaurant_owner', 'admin'), async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description, address, lat, lon, cuisineType, prepTimeMinutes, isOpen, deliveryFee, minOrder } =
      req.body;

    // Check ownership
    const existing = await query('SELECT owner_id FROM restaurants WHERE id = $1', [id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Restaurant not found' });
    }
    if (existing.rows[0].owner_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const result = await query(
      `UPDATE restaurants SET
        name = COALESCE($2, name),
        description = COALESCE($3, description),
        address = COALESCE($4, address),
        lat = COALESCE($5, lat),
        lon = COALESCE($6, lon),
        cuisine_type = COALESCE($7, cuisine_type),
        prep_time_minutes = COALESCE($8, prep_time_minutes),
        is_open = COALESCE($9, is_open),
        delivery_fee = COALESCE($10, delivery_fee),
        min_order = COALESCE($11, min_order),
        updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [id, name, description, address, lat, lon, cuisineType, prepTimeMinutes, isOpen, deliveryFee, minOrder]
    );

    // Invalidate cache on update
    await invalidateRestaurantCache(id);

    logger.info({ restaurantId: id, updatedBy: req.user.id }, 'Restaurant updated');

    res.json({ restaurant: result.rows[0] });
  } catch (err) {
    logger.error({ error: err.message, restaurantId: req.params.id }, 'Update restaurant error');
    res.status(500).json({ error: 'Failed to update restaurant' });
  }
});

// Menu item routes

// Add menu item (with cache invalidation)
router.post('/:id/menu', requireAuth, requireRole('restaurant_owner', 'admin'), async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description, price, category } = req.body;

    // Check ownership
    const existing = await query('SELECT owner_id FROM restaurants WHERE id = $1', [id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Restaurant not found' });
    }
    if (existing.rows[0].owner_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Not authorized' });
    }

    if (!name || !price) {
      return res.status(400).json({ error: 'Name and price are required' });
    }

    const result = await query(
      `INSERT INTO menu_items (restaurant_id, name, description, price, category)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [id, name, description, price, category]
    );

    // Invalidate menu cache
    await invalidateMenuCache(id);

    logger.info({ restaurantId: id, itemId: result.rows[0].id }, 'Menu item added');

    res.status(201).json({ item: result.rows[0] });
  } catch (err) {
    logger.error({ error: err.message, restaurantId: req.params.id }, 'Add menu item error');
    res.status(500).json({ error: 'Failed to add menu item' });
  }
});

// Update menu item (with cache invalidation)
router.put('/:restaurantId/menu/:itemId', requireAuth, requireRole('restaurant_owner', 'admin'), async (req, res) => {
  try {
    const { restaurantId, itemId } = req.params;
    const { name, description, price, category, isAvailable } = req.body;

    // Check ownership
    const existing = await query('SELECT owner_id FROM restaurants WHERE id = $1', [restaurantId]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Restaurant not found' });
    }
    if (existing.rows[0].owner_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const result = await query(
      `UPDATE menu_items SET
        name = COALESCE($2, name),
        description = COALESCE($3, description),
        price = COALESCE($4, price),
        category = COALESCE($5, category),
        is_available = COALESCE($6, is_available),
        updated_at = NOW()
       WHERE id = $1 AND restaurant_id = $7
       RETURNING *`,
      [itemId, name, description, price, category, isAvailable, restaurantId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Menu item not found' });
    }

    // Invalidate menu cache
    await invalidateMenuCache(restaurantId);

    logger.info({ restaurantId, itemId, updatedBy: req.user.id }, 'Menu item updated');

    res.json({ item: result.rows[0] });
  } catch (err) {
    logger.error({ error: err.message, restaurantId: req.params.restaurantId, itemId: req.params.itemId }, 'Update menu item error');
    res.status(500).json({ error: 'Failed to update menu item' });
  }
});

// Delete menu item (with cache invalidation)
router.delete(
  '/:restaurantId/menu/:itemId',
  requireAuth,
  requireRole('restaurant_owner', 'admin'),
  async (req, res) => {
    try {
      const { restaurantId, itemId } = req.params;

      // Check ownership
      const existing = await query('SELECT owner_id FROM restaurants WHERE id = $1', [restaurantId]);
      if (existing.rows.length === 0) {
        return res.status(404).json({ error: 'Restaurant not found' });
      }
      if (existing.rows[0].owner_id !== req.user.id && req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Not authorized' });
      }

      await query('DELETE FROM menu_items WHERE id = $1 AND restaurant_id = $2', [itemId, restaurantId]);

      // Invalidate menu cache
      await invalidateMenuCache(restaurantId);

      logger.info({ restaurantId, itemId, deletedBy: req.user.id }, 'Menu item deleted');

      res.json({ success: true });
    } catch (err) {
      logger.error({ error: err.message, restaurantId: req.params.restaurantId, itemId: req.params.itemId }, 'Delete menu item error');
      res.status(500).json({ error: 'Failed to delete menu item' });
    }
  }
);

export default router;
