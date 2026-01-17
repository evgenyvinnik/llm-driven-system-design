import redis from '../utils/redis.js';
import { query } from '../utils/db.js';
import config from '../config/index.js';

const DRIVERS_GEO_KEY = 'drivers:available';
const DRIVER_STATUS_PREFIX = 'driver:status:';
const DRIVER_LOCATION_PREFIX = 'driver:location:';

class LocationService {
  // Update driver location in Redis
  async updateDriverLocation(driverId, lat, lng) {
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

    // Update PostgreSQL (async, for persistence)
    this.persistLocation(driverId, lat, lng).catch((err) =>
      console.error('Error persisting location:', err)
    );

    return { success: true };
  }

  // Persist location to PostgreSQL
  async persistLocation(driverId, lat, lng) {
    await query('UPDATE drivers SET current_lat = $1, current_lng = $2, updated_at = NOW() WHERE user_id = $3', [
      lat,
      lng,
      driverId,
    ]);
  }

  // Set driver as available/unavailable
  async setDriverAvailability(driverId, isAvailable, lat = null, lng = null) {
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
    await query('UPDATE drivers SET is_available = $1, is_online = $2, updated_at = NOW() WHERE user_id = $3', [
      isAvailable,
      isAvailable,
      driverId,
    ]);

    return { success: true };
  }

  // Set driver as busy (on a ride)
  async setDriverBusy(driverId) {
    await redis.zrem(DRIVERS_GEO_KEY, driverId);
    await redis.set(`${DRIVER_STATUS_PREFIX}${driverId}`, 'on_ride');

    await query('UPDATE drivers SET is_available = FALSE, updated_at = NOW() WHERE user_id = $1', [driverId]);

    return { success: true };
  }

  // Find nearby available drivers
  async findNearbyDrivers(lat, lng, radiusKm = 5, limit = 20) {
    // Use Redis GEORADIUS to find nearby drivers
    const drivers = await redis.georadius(
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
    );

    if (!drivers || drivers.length === 0) {
      return [];
    }

    // Parse results and get driver details
    const driverIds = drivers.map((d) => d[0]);

    if (driverIds.length === 0) {
      return [];
    }

    // Get driver details from PostgreSQL
    const placeholders = driverIds.map((_, i) => `$${i + 1}`).join(',');
    const result = await query(
      `SELECT u.id, u.name, u.rating, u.rating_count,
              d.vehicle_type, d.vehicle_make, d.vehicle_model, d.vehicle_color, d.license_plate
       FROM users u
       JOIN drivers d ON u.id = d.user_id
       WHERE u.id IN (${placeholders})`,
      driverIds
    );

    const driverMap = new Map(result.rows.map((d) => [d.id, d]));

    return drivers
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
      .filter(Boolean);
  }

  // Get driver's current location
  async getDriverLocation(driverId) {
    const location = await redis.hgetall(`${DRIVER_LOCATION_PREFIX}${driverId}`);

    if (!location || !location.lat) {
      // Fall back to PostgreSQL
      const result = await query('SELECT current_lat, current_lng FROM drivers WHERE user_id = $1', [driverId]);

      if (result.rows.length === 0) {
        return null;
      }

      return {
        lat: parseFloat(result.rows[0].current_lat),
        lng: parseFloat(result.rows[0].current_lng),
        timestamp: Date.now(),
      };
    }

    return {
      lat: parseFloat(location.lat),
      lng: parseFloat(location.lng),
      timestamp: parseInt(location.timestamp, 10),
    };
  }

  // Get driver status
  async getDriverStatus(driverId) {
    const status = await redis.get(`${DRIVER_STATUS_PREFIX}${driverId}`);
    return status || 'offline';
  }

  // Count available drivers in an area (for surge pricing)
  async countAvailableDrivers(lat, lng, radiusKm = 3) {
    const count = await redis.georadius(DRIVERS_GEO_KEY, lng, lat, radiusKm, 'km', 'COUNT', 1000);
    return count ? count.length : 0;
  }
}

export default new LocationService();
