/**
 * Driver matching module.
 * @module routes/orders/driver-matching
 * @description Handles the automatic matching of drivers to confirmed orders
 * using a score-based algorithm with circuit breaker protection.
 */

import { query } from '../../db.js';
import redisClient from '../../redis.js';
import { haversineDistance, calculateETA } from '../../utils/geo.js';
import { broadcast } from '../../websocket.js';
import logger from '../../shared/logger.js';
import { driverMatchDuration, driverAssignmentsTotal } from '../../shared/metrics.js';
import { auditDriverAssigned } from '../../shared/audit.js';
import { getDriverMatchCircuitBreaker, DriverMatchResult } from '../../shared/circuit-breaker.js';
import { publishDispatchEvent } from '../../shared/kafka.js';
import { NearbyDriver, ScoredDriver } from './types.js';
import { getOrderWithDetails, calculateMatchScore } from './helpers.js';

/**
 * Finds available drivers within a geographic radius of a location.
 * @description Uses Redis geo commands for efficient spatial queries. If Redis is unavailable,
 * falls back to a database query with manual distance calculation using the Haversine formula.
 *
 * The function:
 * 1. Queries Redis GEOSEARCH for drivers within the radius
 * 2. Filters results to only include active and available drivers
 * 3. Returns drivers sorted by distance (closest first)
 *
 * @param lat - Latitude of the search center point (typically restaurant location)
 * @param lon - Longitude of the search center point
 * @param radiusKm - Search radius in kilometers
 * @returns Array of nearby drivers with their IDs and distances, limited to 20 results
 *
 * @example
 * ```typescript
 * const drivers = await findNearbyDrivers(37.7749, -122.4194, 5);
 * // Returns: [{ id: 1, distance: 0.5 }, { id: 2, distance: 1.2 }, ...]
 * ```
 */
async function findNearbyDrivers(lat: number, lon: number, radiusKm: number): Promise<NearbyDriver[]> {
  try {
    // Use Redis GEOSEARCH
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const results = await (redisClient as any).geoSearch(
      'driver_locations',
      { longitude: lon, latitude: lat },
      {
        radius: radiusKm,
        unit: 'km',
      },
      {
        WITHDIST: true,
        SORT: 'ASC',
        COUNT: 20,
      }
    ) as Array<{ member: string; distance: number }>;

    // Filter by availability from database
    const availableDrivers: NearbyDriver[] = [];
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
    const error = err as Error;
    logger.warn({ error: error.message }, 'Redis geo search failed, falling back to database');
    // Fallback to database query
    const result = await query(
      `SELECT id, current_lat, current_lon FROM drivers
       WHERE is_active = true AND is_available = true
       AND current_lat IS NOT NULL AND current_lon IS NOT NULL`
    );

    return result.rows
      .map((d: { id: number; current_lat: string; current_lon: string }) => ({
        id: d.id,
        distance: haversineDistance(lat, lon, parseFloat(d.current_lat), parseFloat(d.current_lon)),
      }))
      .filter((d: NearbyDriver) => d.distance <= radiusKm)
      .sort((a: NearbyDriver, b: NearbyDriver) => a.distance - b.distance)
      .slice(0, 20);
  }
}

/**
 * Matches the best available driver to an order using a scoring algorithm.
 * @description Implements the driver matching logic with circuit breaker protection
 * to prevent cascading failures. The matching process:
 *
 * 1. Verifies the order exists and has no driver assigned
 * 2. Finds nearby available drivers within 5km of the restaurant
 * 3. Scores each driver based on distance, rating, and experience
 * 4. Assigns the highest-scoring driver to the order
 * 5. Marks the driver as unavailable
 * 6. Calculates ETA for the delivery
 * 7. Creates an audit log entry
 * 8. Notifies the driver via WebSocket
 * 9. Publishes a dispatch event to Kafka
 *
 * The circuit breaker prevents repeated failures from overwhelming the system
 * when driver matching is experiencing issues.
 *
 * @param orderId - The ID of the order to match a driver to
 * @returns Result object indicating success/failure and reason
 *
 * @example
 * ```typescript
 * const result = await matchDriverToOrder(123);
 * if (result.matched) {
 *   console.log(`Driver ${result.driverId} assigned to order`);
 * } else {
 *   console.log(`Matching failed: ${result.reason}`);
 * }
 * ```
 *
 * @throws Returns error result instead of throwing when matching fails
 */
export async function matchDriverToOrder(orderId: number): Promise<DriverMatchResult> {
  const startTime = Date.now();
  const breaker = getDriverMatchCircuitBreaker();

  try {
    const result = await breaker.fire(async (): Promise<DriverMatchResult> => {
      const order = await getOrderWithDetails(orderId);
      if (!order || order.driver_id) {
        return { matched: false, reason: 'already_matched' };
      }

      // Find nearby available drivers using Redis geo
      const nearbyDrivers = await findNearbyDrivers(order.restaurant!.lat, order.restaurant!.lon, 5);

      if (nearbyDrivers.length === 0) {
        logger.warn({ orderId }, 'No drivers available for order');
        return { matched: false, reason: 'no_drivers' };
      }

      // Score drivers
      const scoredDrivers = await Promise.all(
        nearbyDrivers.map(async (d): Promise<ScoredDriver | null> => {
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

      const validDrivers = scoredDrivers
        .filter((d): d is ScoredDriver => d !== null)
        .sort((a, b) => b.score - a.score);

      if (validDrivers.length === 0) {
        return { matched: false, reason: 'no_valid_drivers' };
      }

      // Assign best driver
      const bestMatch = validDrivers[0];
      await query(`UPDATE orders SET driver_id = $1, updated_at = NOW() WHERE id = $2`, [
        bestMatch.driver.id,
        orderId,
      ]);

      // Mark driver as unavailable
      await query(`UPDATE drivers SET is_available = false WHERE id = $1`, [bestMatch.driver.id]);

      // Calculate ETA
      const fullOrder = await getOrderWithDetails(orderId);
      const eta = calculateETA(
        {
          status: fullOrder!.status,
          preparing_at: fullOrder!.preparing_at,
          confirmed_at: fullOrder!.confirmed_at,
          placed_at: fullOrder!.placed_at,
          delivery_address: fullOrder!.delivery_address,
        },
        {
          current_lat: bestMatch.driver.current_lat!,
          current_lon: bestMatch.driver.current_lon!,
        },
        {
          lat: order.restaurant!.lat,
          lon: order.restaurant!.lon,
          prep_time_minutes: order.restaurant!.prep_time_minutes,
        }
      );
      await query('UPDATE orders SET estimated_delivery_at = $1 WHERE id = $2', [eta.eta, orderId]);

      // Create audit log for driver assignment
      await auditDriverAssigned(orderId, bestMatch.driver.id, {
        score: bestMatch.score,
        distance: bestMatch.distance,
      });

      // Notify driver
      broadcast(`driver:${bestMatch.driver.user_id}:orders`, {
        type: 'order_assigned',
        order: await getOrderWithDetails(orderId),
        eta,
      });

      logger.info(
        {
          orderId,
          driverId: bestMatch.driver.id,
          score: bestMatch.score,
          distance: bestMatch.distance,
        },
        'Driver assigned to order'
      );

      // Publish dispatch event to Kafka
      publishDispatchEvent(orderId.toString(), bestMatch.driver.id.toString(), 'assigned', {
        score: bestMatch.score,
        distance: bestMatch.distance,
        estimatedDelivery: eta.eta,
      });

      return { matched: true, driverId: bestMatch.driver.id };
    });

    // Record metrics
    const duration = (Date.now() - startTime) / 1000;
    driverMatchDuration.observe(duration);

    if (result.matched) {
      driverAssignmentsTotal.inc({ result: 'success' });
    } else {
      driverAssignmentsTotal.inc({ result: result.reason || 'no_drivers' });
    }

    return result;
  } catch (error) {
    const err = error as Error;
    logger.error({ error: err.message, orderId }, 'Driver matching failed');
    driverAssignmentsTotal.inc({ result: 'error' });
    return { matched: false, reason: 'error', error: err.message };
  }
}
