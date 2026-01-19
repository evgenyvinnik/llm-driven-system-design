import redis from '../utils/redis.js';
import { query } from '../utils/db.js';
import { createCircuitBreakerWithFallback, withRetry } from '../utils/circuitBreaker.js';
import { createLogger } from '../utils/logger.js';
import { metrics } from '../utils/metrics.js';
import type { NearbyDriver, DriverLocation, VehicleType } from '../types/index.js';

const logger = createLogger('location-service');

const DRIVERS_GEO_KEY = 'drivers:available';
const DRIVER_STATUS_PREFIX = 'driver:status:';
const DRIVER_LOCATION_PREFIX = 'driver:location:';

// Type for Redis geo operation
type GeoOperation = 'georadius' | 'geoadd' | 'zrem';

// Circuit breaker for Redis geo operations
const redisGeoCircuitBreaker = createCircuitBreakerWithFallback<[GeoOperation, ...unknown[]], unknown>(
  async (operation: GeoOperation, ...args: unknown[]): Promise<unknown> => {
    switch (operation) {
      case 'georadius':
        return await (redis.georadius as (...args: unknown[]) => Promise<unknown>)(...args);
      case 'geoadd':
        return await (redis.geoadd as (...args: unknown[]) => Promise<unknown>)(...args);
      case 'zrem':
        return await (redis.zrem as (...args: unknown[]) => Promise<unknown>)(...args);
      default:
        throw new Error(`Unknown operation: ${operation}`);
    }
  },
  'redis-geo',
  // Fallback: return empty results for queries, throw for writes
  async (operation: GeoOperation): Promise<unknown> => {
    if (operation === 'georadius') {
      logger.warn('Redis geo circuit open, returning empty driver list');
      return [];
    }
    throw new Error('Redis geo operations unavailable');
  },
  {
    timeout: 3000, // 3 second timeout for geo operations
    errorThresholdPercentage: 50,
    resetTimeout: 15000, // 15 seconds before trying again
    volumeThreshold: 5,
  }
);

// Database row types
interface DriverQueryRow {
  id: string;
  name: string;
  rating: string;
  rating_count: number;
  vehicle_type: VehicleType;
  vehicle_make: string;
  vehicle_model: string;
  vehicle_color: string;
  license_plate: string;
  current_lat?: string;
  current_lng?: string;
}

interface DriverMetricsRow {
  vehicle_type: VehicleType;
  online_count: string;
  available_count: string;
}

class LocationService {
  // Update driver location in Redis
  async updateDriverLocation(driverId: string, lat: number, lng: number): Promise<{ success: boolean }> {
    const startTime = Date.now();

    try {
      const multi = redis.multi();

      // Update geospatial index
      multi.geoadd(DRIVERS_GEO_KEY, lng, lat, driverId);

      // Store location with timestamp
      multi.hset(
        `${DRIVER_LOCATION_PREFIX}${driverId}`,
        'lat',
        lat.toString(),
        'lng',
        lng.toString(),
        'timestamp',
        Date.now().toString()
      );

      // Set TTL for location data
      multi.expire(`${DRIVER_LOCATION_PREFIX}${driverId}`, 60);

      await multi.exec();

      // Track metrics
      metrics.driverLocationUpdates.inc();
      const duration = (Date.now() - startTime) / 1000;
      metrics.geoQueryDuration.observe({ operation: 'update_location', success: 'true' }, duration);
      metrics.geoOperationsTotal.inc({ operation: 'update_location', success: 'true' });

      // Update PostgreSQL (async, for persistence)
      this.persistLocation(driverId, lat, lng).catch((err: Error) =>
        logger.error({ driverId, error: err.message }, 'Error persisting location')
      );

      return { success: true };
    } catch (error) {
      const err = error as Error;
      const duration = (Date.now() - startTime) / 1000;
      metrics.geoQueryDuration.observe({ operation: 'update_location', success: 'false' }, duration);
      metrics.geoOperationsTotal.inc({ operation: 'update_location', success: 'false' });
      logger.error({ driverId, error: err.message }, 'Failed to update driver location');
      throw error;
    }
  }

  // Persist location to PostgreSQL
  async persistLocation(driverId: string, lat: number, lng: number): Promise<void> {
    await withRetry(
      async () => {
        await query(
          'UPDATE drivers SET current_lat = $1, current_lng = $2, updated_at = NOW() WHERE user_id = $3',
          [lat, lng, driverId]
        );
      },
      {
        maxRetries: 2,
        baseDelay: 100,
        onRetry: (attempt, delay, error) => {
          logger.warn({ driverId, attempt, error: error.message }, 'Retrying location persistence');
        },
      }
    );
  }

  // Set driver as available/unavailable
  async setDriverAvailability(
    driverId: string,
    isAvailable: boolean,
    lat: number | null = null,
    lng: number | null = null
  ): Promise<{ success: boolean }> {
    const startTime = Date.now();

    try {
      const multi = redis.multi();

      if (isAvailable && lat !== null && lng !== null) {
        multi.geoadd(DRIVERS_GEO_KEY, lng, lat, driverId);
        multi.set(`${DRIVER_STATUS_PREFIX}${driverId}`, 'available');
      } else {
        multi.zrem(DRIVERS_GEO_KEY, driverId);
        multi.set(`${DRIVER_STATUS_PREFIX}${driverId}`, isAvailable ? 'available' : 'offline');
      }

      await multi.exec();

      // Update PostgreSQL
      await query(
        'UPDATE drivers SET is_available = $1, is_online = $2, updated_at = NOW() WHERE user_id = $3',
        [isAvailable, isAvailable, driverId]
      );

      // Update driver availability metrics
      await this.updateDriverMetrics();

      const duration = (Date.now() - startTime) / 1000;
      metrics.geoOperationsTotal.inc({ operation: 'set_availability', success: 'true' });

      logger.info(
        { driverId, isAvailable, lat, lng },
        `Driver ${isAvailable ? 'went online' : 'went offline'}`
      );

      return { success: true };
    } catch (error) {
      const err = error as Error;
      metrics.geoOperationsTotal.inc({ operation: 'set_availability', success: 'false' });
      logger.error({ driverId, error: err.message }, 'Failed to set driver availability');
      throw error;
    }
  }

  // Set driver as busy (on a ride)
  async setDriverBusy(driverId: string): Promise<{ success: boolean }> {
    try {
      await redisGeoCircuitBreaker.fire('zrem', DRIVERS_GEO_KEY, driverId);
      await redis.set(`${DRIVER_STATUS_PREFIX}${driverId}`, 'on_ride');

      await query('UPDATE drivers SET is_available = FALSE, updated_at = NOW() WHERE user_id = $1', [driverId]);

      // Update metrics
      await this.updateDriverMetrics();

      logger.info({ driverId }, 'Driver set to busy (on ride)');

      return { success: true };
    } catch (error) {
      const err = error as Error;
      logger.error({ driverId, error: err.message }, 'Failed to set driver busy');
      throw error;
    }
  }

  // Find nearby available drivers - uses circuit breaker
  async findNearbyDrivers(lat: number, lng: number, radiusKm: number = 5, limit: number = 20): Promise<NearbyDriver[]> {
    const startTime = Date.now();

    try {
      // Use circuit breaker for geo operation
      const drivers = await redisGeoCircuitBreaker.fire(
        'georadius',
        DRIVERS_GEO_KEY,
        lng,
        lat,
        radiusKm,
        'km',
        'WITHCOORD',
        'WITHDIST',
        'COUNT',
        limit,
        'ASC'
      ) as [string, string, [string, string]][] | null;

      const duration = (Date.now() - startTime) / 1000;
      metrics.geoQueryDuration.observe({ operation: 'find_nearby', success: 'true' }, duration);
      metrics.geoOperationsTotal.inc({ operation: 'find_nearby', success: 'true' });

      if (!drivers || drivers.length === 0) {
        return [];
      }

      // Parse results and get driver details
      const driverIds = drivers.map((d) => d[0]);

      if (driverIds.length === 0) {
        return [];
      }

      // Get driver details from PostgreSQL with retry
      const result = await withRetry(
        async () => {
          const placeholders = driverIds.map((_, i) => `$${i + 1}`).join(',');
          return await query<DriverQueryRow>(
            `SELECT u.id, u.name, u.rating, u.rating_count,
                    d.vehicle_type, d.vehicle_make, d.vehicle_model, d.vehicle_color, d.license_plate
             FROM users u
             JOIN drivers d ON u.id = d.user_id
             WHERE u.id IN (${placeholders})`,
            driverIds
          );
        },
        { maxRetries: 2, baseDelay: 50 }
      );

      const driverMap = new Map(result.rows.map((d) => [d.id, d]));

      const enrichedDrivers: NearbyDriver[] = drivers
        .map((d) => {
          const driverId = d[0];
          const distanceKm = parseFloat(d[1]);
          const [driverLng, driverLat] = d[2].map(parseFloat);
          const driverInfo = driverMap.get(driverId);

          if (!driverInfo) return null;

          return {
            id: driverId,
            name: driverInfo.name,
            rating: parseFloat(driverInfo.rating),
            ratingCount: driverInfo.rating_count,
            vehicleType: driverInfo.vehicle_type,
            vehicleMake: driverInfo.vehicle_make,
            vehicleModel: driverInfo.vehicle_model,
            vehicleColor: driverInfo.vehicle_color,
            licensePlate: driverInfo.license_plate,
            lat: driverLat,
            lng: driverLng,
            distanceKm,
          };
        })
        .filter((d): d is NearbyDriver => d !== null);

      logger.debug(
        { lat, lng, radiusKm, driversFound: enrichedDrivers.length, duration },
        'Found nearby drivers'
      );

      return enrichedDrivers;
    } catch (error) {
      const err = error as Error;
      const duration = (Date.now() - startTime) / 1000;
      metrics.geoQueryDuration.observe({ operation: 'find_nearby', success: 'false' }, duration);
      metrics.geoOperationsTotal.inc({ operation: 'find_nearby', success: 'false' });
      logger.error({ lat, lng, radiusKm, error: err.message }, 'Failed to find nearby drivers');

      // Return empty array on error (graceful degradation)
      return [];
    }
  }

  // Get driver's current location
  async getDriverLocation(driverId: string): Promise<DriverLocation | null> {
    try {
      const location = await redis.hgetall(`${DRIVER_LOCATION_PREFIX}${driverId}`);

      if (!location || !location.lat) {
        // Fall back to PostgreSQL
        const result = await query<{ current_lat: string; current_lng: string }>(
          'SELECT current_lat, current_lng FROM drivers WHERE user_id = $1',
          [driverId]
        );

        if (result.rows.length === 0) {
          return null;
        }

        return {
          lat: parseFloat(result.rows[0].current_lat),
          lng: parseFloat(result.rows[0].current_lng),
          timestamp: Date.now(),
          source: 'postgres',
        };
      }

      return {
        lat: parseFloat(location.lat),
        lng: parseFloat(location.lng),
        timestamp: parseInt(location.timestamp, 10),
        source: 'redis',
      };
    } catch (error) {
      const err = error as Error;
      logger.error({ driverId, error: err.message }, 'Failed to get driver location');
      return null;
    }
  }

  // Get driver status
  async getDriverStatus(driverId: string): Promise<string> {
    try {
      const status = await redis.get(`${DRIVER_STATUS_PREFIX}${driverId}`);
      return status || 'offline';
    } catch (error) {
      const err = error as Error;
      logger.error({ driverId, error: err.message }, 'Failed to get driver status');
      return 'unknown';
    }
  }

  // Count available drivers in an area (for surge pricing) - uses circuit breaker
  async countAvailableDrivers(lat: number, lng: number, radiusKm: number = 3): Promise<number> {
    try {
      const count = await redisGeoCircuitBreaker.fire(
        'georadius',
        DRIVERS_GEO_KEY,
        lng,
        lat,
        radiusKm,
        'km',
        'COUNT',
        1000
      ) as string[] | null;
      return count ? count.length : 0;
    } catch (error) {
      const err = error as Error;
      logger.error({ lat, lng, radiusKm, error: err.message }, 'Failed to count available drivers');
      return 0; // Return 0 on error (will result in surge pricing if there's demand)
    }
  }

  // Update driver metrics (called periodically or on status changes)
  async updateDriverMetrics(): Promise<void> {
    try {
      // Get counts from database for accuracy
      const result = await query<DriverMetricsRow>(`
        SELECT
          vehicle_type,
          SUM(CASE WHEN is_online THEN 1 ELSE 0 END) as online_count,
          SUM(CASE WHEN is_available THEN 1 ELSE 0 END) as available_count
        FROM drivers
        GROUP BY vehicle_type
      `);

      for (const row of result.rows) {
        metrics.driversOnlineGauge.set(
          { vehicle_type: row.vehicle_type },
          parseInt(row.online_count)
        );
        metrics.driversAvailableGauge.set(
          { vehicle_type: row.vehicle_type },
          parseInt(row.available_count)
        );
      }
    } catch (error) {
      const err = error as Error;
      logger.error({ error: err.message }, 'Failed to update driver metrics');
    }
  }
}

export default new LocationService();
