import redisClient from '../redis.js';
import logger from './logger.js';
import { cacheHits, cacheMisses } from './metrics.js';

export interface Restaurant {
  id: number;
  name: string;
  description?: string;
  address: string;
  lat: number;
  lon: number;
  cuisine_type?: string;
  rating?: number;
  rating_count?: number;
  prep_time_minutes?: number;
  is_open?: boolean;
  image_url?: string;
  delivery_fee?: number;
  min_order?: number;
}

export interface MenuItem {
  id: number;
  name: string;
  description?: string;
  price: number;
  category?: string;
  image_url?: string;
  is_available?: boolean;
}

export interface RestaurantWithMenu {
  restaurant: Restaurant;
  menu: Record<string, MenuItem[]>;
}

/**
 * Cache TTL values (in seconds)
 */
export const CACHE_TTL = {
  RESTAURANT: 300, // 5 minutes
  MENU: 300, // 5 minutes
  RESTAURANT_LIST: 120, // 2 minutes
  NEARBY_RESTAURANTS: 120, // 2 minutes
  CUISINES: 600, // 10 minutes
} as const;

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
} as const;

/**
 * Get a restaurant from cache
 */
export async function getCachedRestaurant(restaurantId: number | string): Promise<Restaurant | null> {
  try {
    const cached = await redisClient.get(`${CACHE_KEYS.RESTAURANT}${restaurantId}`);
    if (cached) {
      cacheHits.inc({ cache_type: 'restaurant' });
      return JSON.parse(cached) as Restaurant;
    }
    cacheMisses.inc({ cache_type: 'restaurant' });
    return null;
  } catch (error) {
    const err = error as Error;
    logger.warn({ error: err.message, restaurantId }, 'Cache read error for restaurant');
    return null;
  }
}

/**
 * Cache a restaurant
 */
export async function setCachedRestaurant(
  restaurantId: number | string,
  data: Restaurant
): Promise<void> {
  try {
    await redisClient.setEx(
      `${CACHE_KEYS.RESTAURANT}${restaurantId}`,
      CACHE_TTL.RESTAURANT,
      JSON.stringify(data)
    );
  } catch (error) {
    const err = error as Error;
    logger.warn({ error: err.message, restaurantId }, 'Cache write error for restaurant');
  }
}

/**
 * Get restaurant with menu from cache
 */
export async function getCachedRestaurantWithMenu(
  restaurantId: number | string
): Promise<RestaurantWithMenu | null> {
  try {
    const cached = await redisClient.get(`${CACHE_KEYS.RESTAURANT_FULL}${restaurantId}`);
    if (cached) {
      cacheHits.inc({ cache_type: 'restaurant_menu' });
      return JSON.parse(cached) as RestaurantWithMenu;
    }
    cacheMisses.inc({ cache_type: 'restaurant_menu' });
    return null;
  } catch (error) {
    const err = error as Error;
    logger.warn({ error: err.message, restaurantId }, 'Cache read error for restaurant menu');
    return null;
  }
}

/**
 * Cache restaurant with menu
 */
export async function setCachedRestaurantWithMenu(
  restaurantId: number | string,
  restaurant: Restaurant,
  menu: Record<string, MenuItem[]>
): Promise<void> {
  try {
    const data: RestaurantWithMenu = { restaurant, menu };
    await redisClient.setEx(
      `${CACHE_KEYS.RESTAURANT_FULL}${restaurantId}`,
      CACHE_TTL.MENU,
      JSON.stringify(data)
    );
  } catch (error) {
    const err = error as Error;
    logger.warn({ error: err.message, restaurantId }, 'Cache write error for restaurant menu');
  }
}

/**
 * Invalidate restaurant cache (including menu)
 * Called when restaurant or menu items are updated
 */
export async function invalidateRestaurantCache(restaurantId: number | string): Promise<void> {
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
    const err = error as Error;
    logger.warn({ error: err.message, restaurantId }, 'Cache invalidation error');
  }
}

/**
 * Invalidate menu cache for a restaurant
 * Called when menu items are added, updated, or deleted
 */
export async function invalidateMenuCache(restaurantId: number | string): Promise<void> {
  try {
    await redisClient.del(`${CACHE_KEYS.RESTAURANT_FULL}${restaurantId}`);
    logger.info({ restaurantId }, 'Menu cache invalidated');
  } catch (error) {
    const err = error as Error;
    logger.warn({ error: err.message, restaurantId }, 'Menu cache invalidation error');
  }
}

/**
 * Get cached cuisines list
 */
export async function getCachedCuisines(): Promise<string[] | null> {
  try {
    const cached = await redisClient.get(CACHE_KEYS.CUISINES);
    if (cached) {
      cacheHits.inc({ cache_type: 'cuisines' });
      return JSON.parse(cached) as string[];
    }
    cacheMisses.inc({ cache_type: 'cuisines' });
    return null;
  } catch (error) {
    const err = error as Error;
    logger.warn({ error: err.message }, 'Cache read error for cuisines');
    return null;
  }
}

/**
 * Cache cuisines list
 */
export async function setCachedCuisines(cuisines: string[]): Promise<void> {
  try {
    await redisClient.setEx(CACHE_KEYS.CUISINES, CACHE_TTL.CUISINES, JSON.stringify(cuisines));
  } catch (error) {
    const err = error as Error;
    logger.warn({ error: err.message }, 'Cache write error for cuisines');
  }
}

/**
 * Get nearby restaurants from cache (by geohash)
 */
export async function getCachedNearbyRestaurants(
  geohash: string,
  radius: number
): Promise<Restaurant[] | null> {
  try {
    const key = `${CACHE_KEYS.NEARBY}${geohash}:${radius}`;
    const cached = await redisClient.get(key);
    if (cached) {
      cacheHits.inc({ cache_type: 'nearby_restaurants' });
      return JSON.parse(cached) as Restaurant[];
    }
    cacheMisses.inc({ cache_type: 'nearby_restaurants' });
    return null;
  } catch (error) {
    const err = error as Error;
    logger.warn({ error: err.message }, 'Cache read error for nearby restaurants');
    return null;
  }
}

/**
 * Cache nearby restaurants
 */
export async function setCachedNearbyRestaurants(
  geohash: string,
  radius: number,
  restaurants: Restaurant[]
): Promise<void> {
  try {
    const key = `${CACHE_KEYS.NEARBY}${geohash}:${radius}`;
    await redisClient.setEx(key, CACHE_TTL.NEARBY_RESTAURANTS, JSON.stringify(restaurants));
  } catch (error) {
    const err = error as Error;
    logger.warn({ error: err.message }, 'Cache write error for nearby restaurants');
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
