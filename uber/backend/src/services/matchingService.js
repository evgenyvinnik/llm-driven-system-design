import { query } from '../utils/db.js';
import redis from '../utils/redis.js';
import locationService from './locationService.js';
import pricingService from './pricingService.js';
import { calculateDistance, estimateTravelTime } from '../utils/geo.js';
import config from '../config/index.js';
import { publishToQueue, publishToExchange, consumeQueue, QUEUES, EXCHANGES } from '../utils/queue.js';
import { createLogger } from '../utils/logger.js';
import { metrics } from '../utils/metrics.js';
import { withRetry } from '../utils/circuitBreaker.js';

const logger = createLogger('matching-service');

const PENDING_REQUESTS_KEY = 'rides:pending';
const RIDE_PREFIX = 'ride:';

class MatchingService {
  constructor() {
    this.wsClients = new Map(); // userId -> WebSocket connection
    this.matchingTimers = new Map(); // rideId -> timer for matching duration tracking
  }

  // Register WebSocket connection for real-time updates
  registerClient(userId, ws) {
    this.wsClients.set(userId, ws);
    logger.debug({ userId }, 'WebSocket client registered');
  }

  // Unregister WebSocket connection
  unregisterClient(userId) {
    this.wsClients.delete(userId);
    logger.debug({ userId }, 'WebSocket client unregistered');
  }

  // Send message to a user
  sendToUser(userId, message) {
    const ws = this.wsClients.get(userId);
    if (ws && ws.readyState === 1) {
      // WebSocket.OPEN
      ws.send(JSON.stringify(message));
      return true;
    }
    return false;
  }

  // Initialize queue consumers for async matching
  async initializeQueues() {
    try {
      // Start consuming matching requests
      await consumeQueue(
        QUEUES.MATCHING_REQUESTS,
        async (message, msg) => {
          await this.processMatchingRequest(message);
        },
        { maxRetries: 3 }
      );

      logger.info('Matching service queue consumers initialized');
    } catch (error) {
      logger.error({ error: error.message }, 'Failed to initialize matching queues');
    }
  }

  // Request a ride - now publishes to queue for async processing
  async requestRide(riderId, pickupLat, pickupLng, dropoffLat, dropoffLng, vehicleType = 'economy', pickupAddress = null, dropoffAddress = null) {
    const startTime = Date.now();

    // Increment demand for surge pricing
    await pricingService.incrementDemand(pickupLat, pickupLng);

    // Get fare estimate
    const fareEstimate = await pricingService.getFareEstimate(
      pickupLat,
      pickupLng,
      dropoffLat,
      dropoffLng,
      vehicleType
    );

    // Track surge pricing metrics
    if (fareEstimate.surgeMultiplier > 1.0) {
      const multiplierRange =
        fareEstimate.surgeMultiplier <= 1.5 ? '1.1-1.5' :
        fareEstimate.surgeMultiplier <= 2.0 ? '1.6-2.0' : '2.1+';
      metrics.surgeEventCounter.inc({ multiplier_range: multiplierRange });
    }

    // Create ride in database with retry
    const result = await withRetry(
      async () => {
        return await query(
          `INSERT INTO rides (
            rider_id, status, pickup_lat, pickup_lng, pickup_address,
            dropoff_lat, dropoff_lng, dropoff_address, vehicle_type,
            estimated_fare_cents, surge_multiplier, distance_meters
          ) VALUES ($1, 'requested', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
          RETURNING *`,
          [
            riderId,
            pickupLat,
            pickupLng,
            pickupAddress,
            dropoffLat,
            dropoffLng,
            dropoffAddress,
            vehicleType,
            fareEstimate.totalFareCents,
            fareEstimate.surgeMultiplier,
            Math.round(fareEstimate.distanceKm * 1000),
          ]
        );
      },
      { maxRetries: 2, baseDelay: 100 }
    );

    const ride = result.rows[0];

    // Store in Redis for quick access
    await redis.hset(`${RIDE_PREFIX}${ride.id}`, {
      riderId,
      status: 'requested',
      pickupLat: pickupLat.toString(),
      pickupLng: pickupLng.toString(),
      dropoffLat: dropoffLat.toString(),
      dropoffLng: dropoffLng.toString(),
      vehicleType,
      createdAt: Date.now().toString(),
    });

    // Add to pending requests
    await redis.zadd(PENDING_REQUESTS_KEY, Date.now(), ride.id);

    // Track metrics
    metrics.rideRequestsTotal.inc({ vehicle_type: vehicleType, status: 'requested' });
    metrics.rideStatusGauge.inc({ status: 'requested' });

    // Start matching timer for latency tracking
    this.matchingTimers.set(ride.id, startTime);

    // Publish matching request to queue for async processing
    await publishToQueue(QUEUES.MATCHING_REQUESTS, {
      requestId: ride.id, // Use ride ID as idempotency key
      rideId: ride.id,
      pickupLocation: { lat: pickupLat, lng: pickupLng },
      dropoffLocation: { lat: dropoffLat, lng: dropoffLng },
      vehicleType,
      maxWaitSeconds: config.matching.matchingTimeoutSeconds,
      attempt: 1,
      riderId,
    });

    // Publish ride event to fanout exchange
    await publishToExchange(EXCHANGES.RIDE_EVENTS, '', {
      eventId: `${ride.id}-requested`,
      eventType: 'requested',
      rideId: ride.id,
      timestamp: Date.now(),
      payload: {
        riderId,
        pickupLocation: { lat: pickupLat, lng: pickupLng },
        dropoffLocation: { lat: dropoffLat, lng: dropoffLng },
        vehicleType,
        estimatedFare: fareEstimate.totalFareCents,
        surgeMultiplier: fareEstimate.surgeMultiplier,
      },
    });

    logger.info(
      { rideId: ride.id, riderId, vehicleType, surgeMultiplier: fareEstimate.surgeMultiplier },
      'Ride requested'
    );

    return {
      rideId: ride.id,
      status: 'requested',
      fareEstimate,
      pickupLat,
      pickupLng,
      dropoffLat,
      dropoffLng,
      vehicleType,
    };
  }

  // Process matching request from queue
  async processMatchingRequest(message) {
    const { rideId, pickupLocation, vehicleType, attempt, riderId } = message;

    logger.debug({ rideId, attempt }, 'Processing matching request from queue');

    // Check if ride is still pending
    const rideData = await redis.hgetall(`${RIDE_PREFIX}${rideId}`);
    if (!rideData || rideData.status !== 'requested') {
      logger.info({ rideId }, 'Ride no longer pending, skipping matching');
      return;
    }

    await this.findDriver(
      rideId,
      pickupLocation.lat,
      pickupLocation.lng,
      vehicleType,
      attempt
    );
  }

  // Find a driver for the ride
  async findDriver(rideId, pickupLat, pickupLng, vehicleType, attempt = 1) {
    const maxAttempts = 3;
    const radiusMultiplier = attempt; // Expand radius with each attempt

    const radiusKm = Math.min(
      config.matching.searchRadiusKm * radiusMultiplier,
      config.matching.maxSearchRadiusKm
    );

    logger.debug({ rideId, attempt, radiusKm }, 'Searching for nearby drivers');

    // Find nearby drivers
    let drivers = await locationService.findNearbyDrivers(pickupLat, pickupLng, radiusKm);

    // Filter by vehicle type if specified
    if (vehicleType !== 'any') {
      drivers = drivers.filter((d) => d.vehicleType === vehicleType);
    }

    if (drivers.length === 0) {
      if (attempt < maxAttempts) {
        // Requeue with incremented attempt after delay
        setTimeout(async () => {
          await publishToQueue(QUEUES.MATCHING_REQUESTS, {
            requestId: `${rideId}-attempt-${attempt + 1}`,
            rideId,
            pickupLocation: { lat: pickupLat, lng: pickupLng },
            vehicleType,
            attempt: attempt + 1,
          });
        }, 5000);
        return;
      }

      // No drivers found after all attempts
      await this.handleNoDriversFound(rideId);
      return;
    }

    // Score and rank drivers
    const scoredDrivers = await this.scoreDrivers(drivers, pickupLat, pickupLng);

    // Try to match with best driver
    for (const driver of scoredDrivers) {
      const matched = await this.offerRideToDriver(rideId, driver.id, pickupLat, pickupLng);
      if (matched) {
        return; // Successfully matched
      }
    }

    // All drivers declined, retry
    if (attempt < maxAttempts) {
      setTimeout(async () => {
        await publishToQueue(QUEUES.MATCHING_REQUESTS, {
          requestId: `${rideId}-attempt-${attempt + 1}`,
          rideId,
          pickupLocation: { lat: pickupLat, lng: pickupLng },
          vehicleType,
          attempt: attempt + 1,
        });
      }, 5000);
    } else {
      await this.handleNoDriversFound(rideId);
    }
  }

  // Score drivers for ranking
  async scoreDrivers(drivers, pickupLat, pickupLng) {
    const scored = drivers.map((driver) => {
      const eta = estimateTravelTime(driver.distanceKm);

      // Lower ETA is better (invert and normalize)
      const etaScore = Math.max(0, 1 - eta / 30);

      // Higher rating is better
      const ratingScore = (driver.rating - 3) / 2;

      // Weighted combination
      const score = 0.6 * etaScore + 0.4 * ratingScore;

      return {
        ...driver,
        eta,
        score,
      };
    });

    // Sort by score descending
    return scored.sort((a, b) => b.score - a.score);
  }

  // Offer ride to a driver
  async offerRideToDriver(rideId, driverId, pickupLat, pickupLng) {
    // Get ride details
    const rideResult = await query('SELECT * FROM rides WHERE id = $1', [rideId]);
    if (rideResult.rows.length === 0) {
      return false;
    }

    const ride = rideResult.rows[0];

    // Get rider details
    const riderResult = await query('SELECT name, rating FROM users WHERE id = $1', [ride.rider_id]);
    const rider = riderResult.rows[0];

    // Calculate ETA to pickup
    const driverLocation = await locationService.getDriverLocation(driverId);
    if (!driverLocation) return false;

    const distanceToPickup = calculateDistance(
      driverLocation.lat,
      driverLocation.lng,
      pickupLat,
      pickupLng
    );
    const etaMinutes = estimateTravelTime(distanceToPickup);

    // Send ride offer to driver via WebSocket
    const offer = {
      type: 'ride_offer',
      rideId,
      rider: {
        name: rider.name,
        rating: parseFloat(rider.rating),
      },
      pickup: {
        lat: parseFloat(ride.pickup_lat),
        lng: parseFloat(ride.pickup_lng),
        address: ride.pickup_address,
      },
      dropoff: {
        lat: parseFloat(ride.dropoff_lat),
        lng: parseFloat(ride.dropoff_lng),
        address: ride.dropoff_address,
      },
      estimatedFare: ride.estimated_fare_cents,
      distanceKm: ride.distance_meters / 1000,
      etaMinutes,
      expiresIn: 15, // 15 seconds to accept
    };

    const sent = this.sendToUser(driverId, offer);

    if (sent) {
      logger.info({ rideId, driverId, etaMinutes }, 'Ride offer sent to driver');
      // Store pending offer
      redis.setex(`offer:${rideId}:${driverId}`, 20, JSON.stringify(offer));
      return true; // For demo, assume accepted
    }

    return false;
  }

  // Driver accepts the ride
  async acceptRide(rideId, driverId) {
    // Check if ride is still pending
    const rideData = await redis.hgetall(`${RIDE_PREFIX}${rideId}`);
    if (!rideData || rideData.status !== 'requested') {
      return { success: false, error: 'Ride no longer available' };
    }

    // Update ride status with optimistic locking (version check)
    const updateResult = await query(
      `UPDATE rides SET driver_id = $1, status = 'matched', matched_at = NOW()
       WHERE id = $2 AND status = 'requested'
       RETURNING *`,
      [driverId, rideId]
    );

    if (updateResult.rowCount === 0) {
      return { success: false, error: 'Ride already taken' };
    }

    // Update Redis
    await redis.hset(`${RIDE_PREFIX}${rideId}`, 'status', 'matched', 'driverId', driverId);

    // Remove from pending
    await redis.zrem(PENDING_REQUESTS_KEY, rideId);

    // Set driver as busy
    await locationService.setDriverBusy(driverId);

    // Decrement demand
    await pricingService.decrementDemand(parseFloat(rideData.pickupLat), parseFloat(rideData.pickupLng));

    // Track matching duration
    const matchingStartTime = this.matchingTimers.get(rideId);
    if (matchingStartTime) {
      const matchingDuration = (Date.now() - matchingStartTime) / 1000;
      metrics.rideMatchingDuration.observe(
        { vehicle_type: rideData.vehicleType, success: 'true' },
        matchingDuration
      );
      this.matchingTimers.delete(rideId);
    }

    // Update ride status metrics
    metrics.rideStatusGauge.dec({ status: 'requested' });
    metrics.rideStatusGauge.inc({ status: 'matched' });

    // Get driver details
    const driverResult = await query(
      `SELECT u.id, u.name, u.rating, d.vehicle_type, d.vehicle_make, d.vehicle_model, d.vehicle_color, d.license_plate
       FROM users u JOIN drivers d ON u.id = d.user_id WHERE u.id = $1`,
      [driverId]
    );
    const driver = driverResult.rows[0];

    const driverLocation = await locationService.getDriverLocation(driverId);

    // Notify rider
    this.sendToUser(rideData.riderId, {
      type: 'ride_matched',
      rideId,
      driver: {
        id: driver.id,
        name: driver.name,
        rating: parseFloat(driver.rating),
        vehicleType: driver.vehicle_type,
        vehicleMake: driver.vehicle_make,
        vehicleModel: driver.vehicle_model,
        vehicleColor: driver.vehicle_color,
        licensePlate: driver.license_plate,
        location: driverLocation,
      },
    });

    // Publish matched event
    await publishToExchange(EXCHANGES.RIDE_EVENTS, '', {
      eventId: `${rideId}-matched`,
      eventType: 'matched',
      rideId,
      timestamp: Date.now(),
      payload: {
        riderId: rideData.riderId,
        driverId,
      },
    });

    logger.info({ rideId, driverId }, 'Ride matched');

    return {
      success: true,
      ride: {
        id: rideId,
        status: 'matched',
        pickup: {
          lat: parseFloat(rideData.pickupLat),
          lng: parseFloat(rideData.pickupLng),
        },
        dropoff: {
          lat: parseFloat(rideData.dropoffLat),
          lng: parseFloat(rideData.dropoffLng),
        },
        riderId: rideData.riderId,
      },
    };
  }

  // Driver arrives at pickup
  async driverArrived(rideId, driverId) {
    await query(`UPDATE rides SET status = 'driver_arrived', driver_arrived_at = NOW() WHERE id = $1`, [rideId]);

    await redis.hset(`${RIDE_PREFIX}${rideId}`, 'status', 'driver_arrived');

    const rideData = await redis.hgetall(`${RIDE_PREFIX}${rideId}`);

    // Update metrics
    metrics.rideStatusGauge.dec({ status: 'matched' });
    metrics.rideStatusGauge.inc({ status: 'driver_arrived' });

    // Notify rider
    this.sendToUser(rideData.riderId, {
      type: 'driver_arrived',
      rideId,
    });

    logger.info({ rideId, driverId }, 'Driver arrived at pickup');

    return { success: true };
  }

  // Start the ride (pickup completed)
  async startRide(rideId, driverId) {
    await query(`UPDATE rides SET status = 'picked_up', picked_up_at = NOW() WHERE id = $1`, [rideId]);

    await redis.hset(`${RIDE_PREFIX}${rideId}`, 'status', 'picked_up');

    const rideData = await redis.hgetall(`${RIDE_PREFIX}${rideId}`);

    // Update metrics
    metrics.rideStatusGauge.dec({ status: 'driver_arrived' });
    metrics.rideStatusGauge.inc({ status: 'picked_up' });

    // Notify rider
    this.sendToUser(rideData.riderId, {
      type: 'ride_started',
      rideId,
    });

    logger.info({ rideId, driverId }, 'Ride started');

    return { success: true };
  }

  // Complete the ride
  async completeRide(rideId, driverId, finalDistanceMeters = null) {
    const rideResult = await query('SELECT * FROM rides WHERE id = $1', [rideId]);
    if (rideResult.rows.length === 0) {
      return { success: false, error: 'Ride not found' };
    }

    const ride = rideResult.rows[0];

    // Calculate final fare
    const distanceKm = (finalDistanceMeters || ride.distance_meters) / 1000;
    const durationMinutes = ride.picked_up_at
      ? Math.ceil((Date.now() - new Date(ride.picked_up_at).getTime()) / 60000)
      : estimateTravelTime(distanceKm);

    const fareDetails = pricingService.calculateFareEstimate(
      distanceKm,
      durationMinutes,
      ride.vehicle_type,
      parseFloat(ride.surge_multiplier)
    );

    // Update ride
    await query(
      `UPDATE rides SET status = 'completed', completed_at = NOW(),
       final_fare_cents = $1, distance_meters = $2, duration_seconds = $3
       WHERE id = $4`,
      [fareDetails.totalFareCents, Math.round(distanceKm * 1000), durationMinutes * 60, rideId]
    );

    // Update driver stats
    await query(
      `UPDATE drivers SET total_rides = total_rides + 1,
       total_earnings_cents = total_earnings_cents + $1,
       is_available = TRUE, updated_at = NOW()
       WHERE user_id = $2`,
      [fareDetails.totalFareCents, driverId]
    );

    // Clean up Redis
    await redis.del(`${RIDE_PREFIX}${rideId}`);

    // Set driver as available again
    const driverLocation = await locationService.getDriverLocation(driverId);
    if (driverLocation) {
      await locationService.setDriverAvailability(driverId, true, driverLocation.lat, driverLocation.lng);
    }

    // Update metrics
    metrics.rideStatusGauge.dec({ status: 'picked_up' });
    metrics.rideRequestsTotal.inc({ vehicle_type: ride.vehicle_type, status: 'completed' });
    metrics.rideFareHistogram.observe({ vehicle_type: ride.vehicle_type }, fareDetails.totalFareCents);

    // Notify rider
    this.sendToUser(ride.rider_id, {
      type: 'ride_completed',
      rideId,
      fare: fareDetails,
    });

    // Publish completed event
    await publishToExchange(EXCHANGES.RIDE_EVENTS, '', {
      eventId: `${rideId}-completed`,
      eventType: 'completed',
      rideId,
      timestamp: Date.now(),
      payload: {
        riderId: ride.rider_id,
        driverId,
        fare: fareDetails.totalFareCents,
        distanceKm,
        durationMinutes,
      },
    });

    logger.info(
      { rideId, driverId, fare: fareDetails.totalFareCents, distanceKm, durationMinutes },
      'Ride completed'
    );

    return {
      success: true,
      fare: fareDetails,
    };
  }

  // Cancel the ride
  async cancelRide(rideId, cancelledBy, reason = null) {
    const rideResult = await query('SELECT * FROM rides WHERE id = $1', [rideId]);
    if (rideResult.rows.length === 0) {
      return { success: false, error: 'Ride not found' };
    }

    const ride = rideResult.rows[0];

    // Update ride
    await query(
      `UPDATE rides SET status = 'cancelled', cancelled_at = NOW(),
       cancelled_by = $1, cancellation_reason = $2 WHERE id = $3`,
      [cancelledBy, reason, rideId]
    );

    // Clean up Redis
    await redis.zrem(PENDING_REQUESTS_KEY, rideId);
    await redis.del(`${RIDE_PREFIX}${rideId}`);

    // Decrement demand if still pending
    if (ride.status === 'requested') {
      await pricingService.decrementDemand(parseFloat(ride.pickup_lat), parseFloat(ride.pickup_lng));

      // Track failed matching
      const matchingStartTime = this.matchingTimers.get(rideId);
      if (matchingStartTime) {
        const matchingDuration = (Date.now() - matchingStartTime) / 1000;
        metrics.rideMatchingDuration.observe(
          { vehicle_type: ride.vehicle_type, success: 'false' },
          matchingDuration
        );
        this.matchingTimers.delete(rideId);
      }
    }

    // Update metrics
    metrics.rideStatusGauge.dec({ status: ride.status });
    metrics.rideRequestsTotal.inc({ vehicle_type: ride.vehicle_type, status: 'cancelled' });

    // If driver was assigned, make them available
    if (ride.driver_id) {
      const driverLocation = await locationService.getDriverLocation(ride.driver_id);
      if (driverLocation) {
        await locationService.setDriverAvailability(ride.driver_id, true, driverLocation.lat, driverLocation.lng);
      }

      // Notify driver
      this.sendToUser(ride.driver_id, {
        type: 'ride_cancelled',
        rideId,
        cancelledBy,
        reason,
      });
    }

    // Notify rider
    this.sendToUser(ride.rider_id, {
      type: 'ride_cancelled',
      rideId,
      cancelledBy,
      reason,
    });

    // Publish cancelled event
    await publishToExchange(EXCHANGES.RIDE_EVENTS, '', {
      eventId: `${rideId}-cancelled`,
      eventType: 'cancelled',
      rideId,
      timestamp: Date.now(),
      payload: {
        riderId: ride.rider_id,
        driverId: ride.driver_id,
        cancelledBy,
        reason,
      },
    });

    logger.info({ rideId, cancelledBy, reason }, 'Ride cancelled');

    return { success: true };
  }

  // Handle no drivers found
  async handleNoDriversFound(rideId) {
    await query(
      `UPDATE rides SET status = 'cancelled', cancelled_at = NOW(), cancelled_by = 'system', cancellation_reason = 'No drivers available' WHERE id = $1`,
      [rideId]
    );

    const rideData = await redis.hgetall(`${RIDE_PREFIX}${rideId}`);

    // Clean up Redis
    await redis.zrem(PENDING_REQUESTS_KEY, rideId);
    await redis.del(`${RIDE_PREFIX}${rideId}`);

    if (rideData) {
      await pricingService.decrementDemand(parseFloat(rideData.pickupLat), parseFloat(rideData.pickupLng));

      // Track failed matching
      const matchingStartTime = this.matchingTimers.get(rideId);
      if (matchingStartTime) {
        const matchingDuration = (Date.now() - matchingStartTime) / 1000;
        metrics.rideMatchingDuration.observe(
          { vehicle_type: rideData.vehicleType, success: 'false' },
          matchingDuration
        );
        this.matchingTimers.delete(rideId);
      }

      // Update metrics
      metrics.rideStatusGauge.dec({ status: 'requested' });
      metrics.rideRequestsTotal.inc({ vehicle_type: rideData.vehicleType, status: 'no_drivers' });

      // Notify rider
      this.sendToUser(rideData.riderId, {
        type: 'no_drivers_available',
        rideId,
      });
    }

    logger.info({ rideId }, 'No drivers available');
  }

  // Get ride status
  async getRideStatus(rideId) {
    // Try Redis first
    const rideData = await redis.hgetall(`${RIDE_PREFIX}${rideId}`);

    if (rideData && rideData.status) {
      const driverLocation = rideData.driverId
        ? await locationService.getDriverLocation(rideData.driverId)
        : null;

      return {
        id: rideId,
        status: rideData.status,
        pickup: {
          lat: parseFloat(rideData.pickupLat),
          lng: parseFloat(rideData.pickupLng),
        },
        dropoff: {
          lat: parseFloat(rideData.dropoffLat),
          lng: parseFloat(rideData.dropoffLng),
        },
        driverId: rideData.driverId,
        driverLocation,
      };
    }

    // Fall back to database
    const result = await query(
      `SELECT r.*, u.name as driver_name, d.current_lat, d.current_lng,
              d.vehicle_type, d.vehicle_make, d.vehicle_model, d.vehicle_color, d.license_plate
       FROM rides r
       LEFT JOIN users u ON r.driver_id = u.id
       LEFT JOIN drivers d ON r.driver_id = d.user_id
       WHERE r.id = $1`,
      [rideId]
    );

    if (result.rows.length === 0) {
      return null;
    }

    const ride = result.rows[0];

    return {
      id: ride.id,
      status: ride.status,
      pickup: {
        lat: parseFloat(ride.pickup_lat),
        lng: parseFloat(ride.pickup_lng),
        address: ride.pickup_address,
      },
      dropoff: {
        lat: parseFloat(ride.dropoff_lat),
        lng: parseFloat(ride.dropoff_lng),
        address: ride.dropoff_address,
      },
      driver: ride.driver_id
        ? {
            id: ride.driver_id,
            name: ride.driver_name,
            vehicleType: ride.vehicle_type,
            vehicleMake: ride.vehicle_make,
            vehicleModel: ride.vehicle_model,
            vehicleColor: ride.vehicle_color,
            licensePlate: ride.license_plate,
            location: ride.current_lat
              ? { lat: parseFloat(ride.current_lat), lng: parseFloat(ride.current_lng) }
              : null,
          }
        : null,
      fare: {
        estimated: ride.estimated_fare_cents,
        final: ride.final_fare_cents,
        surgeMultiplier: parseFloat(ride.surge_multiplier),
      },
    };
  }
}

export default new MatchingService();
