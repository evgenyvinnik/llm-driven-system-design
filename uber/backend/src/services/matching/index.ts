import type { WebSocket } from 'ws';
import { query } from '../../utils/db.js';
import redis from '../../utils/redis.js';
import pricingService from '../pricingService.js';
import config from '../../config/index.js';
import { publishToQueue, publishToExchange, consumeQueue, QUEUES, EXCHANGES } from '../../utils/queue.js';
import { createLogger } from '../../utils/logger.js';
import { metrics } from '../../utils/metrics.js';
import { withRetry } from '../../utils/circuitBreaker.js';
import type {
  VehicleType,
  RideRow,
  MatchingRequest,
} from '../../types/index.js';

// Import types
import type {
  WSMessage,
  RideRequestResult,
  AcceptRideResult,
  CompleteRideResult,
  CancelRideResult,
  Ride,
} from './types.js';
import { PENDING_REQUESTS_KEY, RIDE_PREFIX } from './types.js';

// Import modules
import { scoreDrivers } from './scoring.js';
import { findDriver, processMatchingRequest, setOfferRideToDriver, setHandleNoDriversFound } from './driver-finder.js';
import { offerRideToDriver, acceptRide, setSendToUser as setAllocationSendToUser, setMatchingTimers as setAllocationTimers } from './allocation.js';
import {
  driverArrived,
  startRide,
  completeRide,
  cancelRide,
  handleNoDriversFound,
  setSendToUser as setLifecycleSendToUser,
  setMatchingTimers as setLifecycleTimers,
} from './ride-lifecycle.js';
import { getRideStatus } from './ride-status.js';

const logger = createLogger('matching-service');

/**
 * @description Main orchestrator service for ride matching operations.
 * Coordinates WebSocket connections, ride requests, driver matching, and ride lifecycle management.
 * Uses a modular architecture with separate modules for scoring, allocation, and lifecycle management.
 * Implements dependency injection to break circular dependencies between modules.
 *
 * The service maintains two internal maps:
 * - wsClients: Maps user IDs to their WebSocket connections for real-time updates
 * - matchingTimers: Tracks matching start times for latency metrics
 */
class MatchingService {
  private wsClients: Map<string, WebSocket> = new Map();
  private matchingTimers: Map<string, number> = new Map();

  /**
   * @description Initializes the MatchingService and wires up dependencies between modules.
   * Sets up function references for modules that need to call each other without creating
   * circular import dependencies.
   */
  constructor() {
    // Wire up dependencies between modules
    setOfferRideToDriver(this.offerRideToDriver.bind(this));
    setHandleNoDriversFound(this.handleNoDriversFound.bind(this));
    setAllocationSendToUser(this.sendToUser.bind(this));
    setAllocationTimers(this.matchingTimers);
    setLifecycleSendToUser(this.sendToUser.bind(this));
    setLifecycleTimers(this.matchingTimers);
  }

  /**
   * @description Registers a WebSocket connection for a user to receive real-time updates.
   * @param {string} userId - Unique identifier of the user (rider or driver)
   * @param {WebSocket} ws - WebSocket connection instance
   * @returns {void}
   */
  registerClient(userId: string, ws: WebSocket): void {
    this.wsClients.set(userId, ws);
    logger.debug({ userId }, 'WebSocket client registered');
  }

  /**
   * @description Removes a user's WebSocket connection when they disconnect.
   * @param {string} userId - Unique identifier of the user to unregister
   * @returns {void}
   */
  unregisterClient(userId: string): void {
    this.wsClients.delete(userId);
    logger.debug({ userId }, 'WebSocket client unregistered');
  }

  /**
   * @description Sends a message to a specific user via their WebSocket connection.
   * @param {string} userId - Unique identifier of the user to send to
   * @param {WSMessage} message - Message object to send (will be JSON stringified)
   * @returns {boolean} True if message was sent successfully, false if user not connected or WebSocket not open
   */
  sendToUser(userId: string, message: WSMessage): boolean {
    const ws = this.wsClients.get(userId);
    if (ws && ws.readyState === 1) {
      // WebSocket.OPEN
      ws.send(JSON.stringify(message));
      return true;
    }
    return false;
  }

  /**
   * @description Initializes RabbitMQ queue consumers for asynchronous matching.
   * Sets up consumption of the matching requests queue with retry logic.
   * Should be called once during service startup.
   * @returns {Promise<void>} Resolves when consumers are initialized
   */
  async initializeQueues(): Promise<void> {
    try {
      // Start consuming matching requests
      await consumeQueue<MatchingRequest>(
        QUEUES.MATCHING_REQUESTS,
        async (message) => {
          await this.processMatchingRequest(message);
        },
        { maxRetries: 3 }
      );

      logger.info('Matching service queue consumers initialized');
    } catch (error) {
      const err = error as Error;
      logger.error({ error: err.message }, 'Failed to initialize matching queues');
    }
  }

  /**
   * @description Creates a new ride request and initiates the matching process.
   * Calculates fare estimate with surge pricing, persists ride to PostgreSQL and Redis,
   * publishes matching request to queue for async processing, and emits ride event.
   *
   * @param {string} riderId - ID of the rider requesting the ride
   * @param {number} pickupLat - Latitude of pickup location
   * @param {number} pickupLng - Longitude of pickup location
   * @param {number} dropoffLat - Latitude of dropoff location
   * @param {number} dropoffLng - Longitude of dropoff location
   * @param {VehicleType} [vehicleType='economy'] - Type of vehicle requested
   * @param {string | null} [pickupAddress=null] - Human-readable pickup address
   * @param {string | null} [dropoffAddress=null] - Human-readable dropoff address
   * @returns {Promise<RideRequestResult>} Result containing ride ID, status, fare estimate, and locations
   *
   * @example
   * const result = await matchingService.requestRide(
   *   'rider-123', 37.7749, -122.4194, 37.7849, -122.4094, 'economy'
   * );
   */
  async requestRide(
    riderId: string,
    pickupLat: number,
    pickupLng: number,
    dropoffLat: number,
    dropoffLng: number,
    vehicleType: VehicleType = 'economy',
    pickupAddress: string | null = null,
    dropoffAddress: string | null = null
  ): Promise<RideRequestResult> {
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
        return await query<RideRow>(
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

  /**
   * @description Processes a matching request from the RabbitMQ queue.
   * Delegates to the driver-finder module.
   * @param {MatchingRequest} message - The matching request message
   * @returns {Promise<void>}
   */
  async processMatchingRequest(message: MatchingRequest): Promise<void> {
    return processMatchingRequest(message);
  }

  /**
   * @description Finds a driver for a ride request.
   * Delegates to the driver-finder module.
   * @param {string} rideId - Unique identifier of the ride
   * @param {number} pickupLat - Pickup latitude
   * @param {number} pickupLng - Pickup longitude
   * @param {VehicleType} vehicleType - Type of vehicle requested
   * @param {number} [attempt=1] - Current matching attempt number
   * @returns {Promise<void>}
   */
  async findDriver(
    rideId: string,
    pickupLat: number,
    pickupLng: number,
    vehicleType: VehicleType,
    attempt: number = 1
  ): Promise<void> {
    return findDriver(rideId, pickupLat, pickupLng, vehicleType, attempt);
  }

  /**
   * @description Reference to the driver scoring function.
   * Scores and ranks drivers based on ETA and rating.
   */
  scoreDrivers = scoreDrivers;

  /**
   * @description Sends a ride offer to a driver via WebSocket.
   * Delegates to the allocation module.
   * @param {string} rideId - Unique identifier of the ride
   * @param {string} driverId - ID of the driver to receive the offer
   * @param {number} pickupLat - Pickup latitude
   * @param {number} pickupLng - Pickup longitude
   * @returns {Promise<boolean>} True if offer was sent successfully
   */
  async offerRideToDriver(
    rideId: string,
    driverId: string,
    pickupLat: number,
    pickupLng: number
  ): Promise<boolean> {
    return offerRideToDriver(rideId, driverId, pickupLat, pickupLng);
  }

  /**
   * @description Processes a driver's acceptance of a ride offer.
   * Delegates to the allocation module.
   * @param {string} rideId - Unique identifier of the ride
   * @param {string} driverId - ID of the driver accepting the ride
   * @returns {Promise<AcceptRideResult>} Result with success status and ride details
   */
  async acceptRide(rideId: string, driverId: string): Promise<AcceptRideResult> {
    return acceptRide(rideId, driverId);
  }

  /**
   * @description Marks a ride as having the driver arrived at pickup.
   * Delegates to the ride-lifecycle module.
   * @param {string} rideId - Unique identifier of the ride
   * @param {string} driverId - ID of the driver
   * @returns {Promise<{success: boolean}>} Object indicating success
   */
  async driverArrived(rideId: string, driverId: string): Promise<{ success: boolean }> {
    return driverArrived(rideId, driverId);
  }

  /**
   * @description Starts the ride after rider pickup.
   * Delegates to the ride-lifecycle module.
   * @param {string} rideId - Unique identifier of the ride
   * @param {string} driverId - ID of the driver
   * @returns {Promise<{success: boolean}>} Object indicating success
   */
  async startRide(rideId: string, driverId: string): Promise<{ success: boolean }> {
    return startRide(rideId, driverId);
  }

  /**
   * @description Completes a ride and calculates final fare.
   * Delegates to the ride-lifecycle module.
   * @param {string} rideId - Unique identifier of the ride
   * @param {string} driverId - ID of the driver
   * @param {number | null} [finalDistanceMeters=null] - Actual distance traveled
   * @returns {Promise<CompleteRideResult>} Result with success status and fare details
   */
  async completeRide(
    rideId: string,
    driverId: string,
    finalDistanceMeters: number | null = null
  ): Promise<CompleteRideResult> {
    return completeRide(rideId, driverId, finalDistanceMeters);
  }

  /**
   * @description Cancels a ride at any stage.
   * Delegates to the ride-lifecycle module.
   * @param {string} rideId - Unique identifier of the ride
   * @param {string} cancelledBy - User ID of who cancelled
   * @param {string | null} [reason=null] - Cancellation reason
   * @returns {Promise<CancelRideResult>} Result with success status
   */
  async cancelRide(
    rideId: string,
    cancelledBy: string,
    reason: string | null = null
  ): Promise<CancelRideResult> {
    return cancelRide(rideId, cancelledBy, reason);
  }

  /**
   * @description Handles the case when no drivers are found for a ride.
   * Delegates to the ride-lifecycle module.
   * @param {string} rideId - Unique identifier of the ride
   * @returns {Promise<void>}
   */
  async handleNoDriversFound(rideId: string): Promise<void> {
    return handleNoDriversFound(rideId);
  }

  /**
   * @description Retrieves the current status of a ride.
   * Delegates to the ride-status module.
   * @param {string} rideId - Unique identifier of the ride
   * @returns {Promise<Ride | null>} Ride object with current status, or null if not found
   */
  async getRideStatus(rideId: string): Promise<Ride | null> {
    return getRideStatus(rideId);
  }
}

export default new MatchingService();

// Also export individual functions for direct use if needed
export {
  scoreDrivers,
  findDriver,
  processMatchingRequest,
  offerRideToDriver,
  acceptRide,
  driverArrived,
  startRide,
  completeRide,
  cancelRide,
  handleNoDriversFound,
  getRideStatus,
};

// Export types for consumers
export type {
  WSMessage,
  RideRequestResult,
  AcceptRideResult,
  CompleteRideResult,
  CancelRideResult,
};
