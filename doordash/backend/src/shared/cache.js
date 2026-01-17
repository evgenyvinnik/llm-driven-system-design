import redisClient from '../redis.js';
import logger from './logger.js';
import { cacheHits, cacheMisses } from './metrics.js';

/**
 * Cache TTL values (in seconds)
 */
export const CACHE_TTL = {
  RESTAURANT: 300, // 5 minutes
  MENU: 300, // 5 minutes
  RESTAURANT_LIST: 120, // 2 minutes
  NEARBY_RESTAURANTS: 120, // 2 minutes
  CUISINES: 600, // 10 minutes
};

/**
 * Cache key prefixes
 */
export const CACHE_KEYS = {
  RESTAURANT: 'cache:restaurant:',
  MENU: 'cache:menu:',
  RESTAURANT_FULL: 'cache:restaurant_full:',
  RESTAURANT_LIST: 'cache:restaurants:list',
  NEARBY: 'cache:nearby:',
  CUISINES: 'cache:cuisines',
};

/**
 * Get a restaurant from cache
 * @param {number} restaurantId - Restaurant ID
 * @returns {Object|null} Restaurant data or null if not cached
 */
export async function getCachedRestaurant(restaurantId) {
  try {
    const cached = await redisClient.get(`${CACHE_KEYS.RESTAURANT}${restaurantId}`);
    if (cached) {
      cacheHits.inc({ cache_type: 'restaurant' });
      return JSON.parse(cached);
    }
    cacheMisses.inc({ cache_type: 'restaurant' });
    return null;
  } catch (error) {
    logger.warn({ error: error.message, restaurantId }, 'Cache read error for restaurant');
    return null;
  }
}

/**
 * Cache a restaurant
 * @param {number} restaurantId - Restaurant ID
 * @param {Object} data - Restaurant data to cache
 */
export async function setCachedRestaurant(restaurantId, data) {
  try {
    await redisClient.setEx(
      `${CACHE_KEYS.RESTAURANT}${restaurantId}`,
      CACHE_TTL.RESTAURANT,
      JSON.stringify(data)
    );
  } catch (error) {
    logger.warn({ error: error.message, restaurantId }, 'Cache write error for restaurant');
  }
}

/**
 * Get restaurant with menu from cache
 * @param {number} restaurantId - Restaurant ID
 * @returns {Object|null} Restaurant with menu data or null if not cached
 */
export async function getCachedRestaurantWithMenu(restaurantId) {
  try {
    const cached = await redisClient.get(`${CACHE_KEYS.RESTAURANT_FULL}${restaurantId}`);
    if (cached) {
      cacheHits.inc({ cache_type: 'restaurant_menu' });
      return JSON.parse(cached);
    }
    cacheMisses.inc({ cache_type: 'restaurant_menu' });
    return null;
  } catch (error) {
    logger.warn({ error: error.message, restaurantId }, 'Cache read error for restaurant menu');
    return null;
  }
}

/**
 * Cache restaurant with menu
 * @param {number} restaurantId - Restaurant ID
 * @param {Object} restaurant - Restaurant data
 * @param {Object} menu - Menu data grouped by category
 */
export async function setCachedRestaurantWithMenu(restaurantId, restaurant, menu) {
  try {
    const data = { restaurant, menu };
    await redisClient.setEx(
      `${CACHE_KEYS.RESTAURANT_FULL}${restaurantId}`,
      CACHE_TTL.MENU,
      JSON.stringify(data)
    );
  } catch (error) {
    logger.warn({ error: error.message, restaurantId }, 'Cache write error for restaurant menu');
  }
}

/**
 * Invalidate restaurant cache (including menu)
 * Called when restaurant or menu items are updated
 * @param {number} restaurantId - Restaurant ID to invalidate
 */
export async function invalidateRestaurantCache(restaurantId) {
  try {
    const keys = [
      `${CACHE_KEYS.RESTAURANT}${restaurantId}`,
      `${CACHE_KEYS.RESTAURANT_FULL}${restaurantId}`,
    ];

    // Delete restaurant-specific caches
    await redisClient.del(keys);

    // Also invalidate list caches since they may contain this restaurant
    const listKeys = await redisClient.keys(`${CACHE_KEYS.RESTAURANT_LIST}*`);
    if (listKeys.length > 0) {
      await redisClient.del(listKeys);
    }

    // Invalidate nearby caches (using pattern matching)
    const nearbyKeys = await redisClient.keys(`${CACHE_KEYS.NEARBY}*`);
    if (nearbyKeys.length > 0) {
      await redisClient.del(nearbyKeys);
    }

    logger.info({ restaurantId }, 'Restaurant cache invalidated');
  } catch (error) {
    logger.warn({ error: error.message, restaurantId }, 'Cache invalidation error');
  }
}

/**
 * Invalidate menu cache for a restaurant
 * Called when menu items are added, updated, or deleted
 * @param {number} restaurantId - Restaurant ID whose menu cache to invalidate
 */
export async function invalidateMenuCache(restaurantId) {
  try {
    await redisClient.del(`${CACHE_KEYS.RESTAURANT_FULL}${restaurantId}`);
    logger.info({ restaurantId }, 'Menu cache invalidated');
  } catch (error) {
    logger.warn({ error: error.message, restaurantId }, 'Menu cache invalidation error');
  }
}

/**
 * Get cached cuisines list
 * @returns {Array|null} Array of cuisine types or null if not cached
 */
export async function getCachedCuisines() {
  try {
    const cached = await redisClient.get(CACHE_KEYS.CUISINES);
    if (cached) {
      cacheHits.inc({ cache_type: 'cuisines' });
      return JSON.parse(cached);
    }
    cacheMisses.inc({ cache_type: 'cuisines' });
    return null;
  } catch (error) {
    logger.warn({ error: error.message }, 'Cache read error for cuisines');
    return null;
  }
}

/**
 * Cache cuisines list
 * @param {Array} cuisines - Array of cuisine types
 */
export async function setCachedCuisines(cuisines) {
  try {
    await redisClient.setEx(CACHE_KEYS.CUISINES, CACHE_TTL.CUISINES, JSON.stringify(cuisines));
  } catch (error) {
    logger.warn({ error: error.message }, 'Cache write error for cuisines');
  }
}

/**
 * Get nearby restaurants from cache (by geohash)
 * @param {string} geohash - Geohash prefix for the area
 * @param {number} radius - Search radius in km
 * @returns {Array|null} Array of restaurants or null if not cached
 */
export async function getCachedNearbyRestaurants(geohash, radius) {
  try {
    const key = `${CACHE_KEYS.NEARBY}${geohash}:${radius}`;
    const cached = await redisClient.get(key);
    if (cached) {
      cacheHits.inc({ cache_type: 'nearby_restaurants' });
      return JSON.parse(cached);
    }
    cacheMisses.inc({ cache_type: 'nearby_restaurants' });
    return null;
  } catch (error) {
    logger.warn({ error: error.message }, 'Cache read error for nearby restaurants');
    return null;
  }
}

/**
 * Cache nearby restaurants
 * @param {string} geohash - Geohash prefix for the area
 * @param {number} radius - Search radius in km
 * @param {Array} restaurants - Array of restaurants
 */
export async function setCachedNearbyRestaurants(geohash, radius, restaurants) {
  try {
    const key = `${CACHE_KEYS.NEARBY}${geohash}:${radius}`;
    await redisClient.setEx(key, CACHE_TTL.NEARBY_RESTAURANTS, JSON.stringify(restaurants));
  } catch (error) {
    logger.warn({ error: error.message }, 'Cache write error for nearby restaurants');
  }
}

export default {
  CACHE_TTL,
  CACHE_KEYS,
  getCachedRestaurant,
  setCachedRestaurant,
  getCachedRestaurantWithMenu,
  setCachedRestaurantWithMenu,
  invalidateRestaurantCache,
  invalidateMenuCache,
  getCachedCuisines,
  setCachedCuisines,
  getCachedNearbyRestaurants,
  setCachedNearbyRestaurants,
};
