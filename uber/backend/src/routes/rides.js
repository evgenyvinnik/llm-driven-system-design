import { Router } from 'express';
import { authenticate, requireRider } from '../middleware/auth.js';
import { idempotencyMiddleware } from '../middleware/idempotency.js';
import matchingService from '../services/matchingService.js';
import pricingService from '../services/pricingService.js';
import locationService from '../services/locationService.js';
import { query } from '../utils/db.js';
import { createLogger } from '../utils/logger.js';

const router = Router();
const logger = createLogger('rides-route');

// Get fare estimate
router.post('/estimate', authenticate, requireRider, async (req, res) => {
  try {
    const { pickupLat, pickupLng, dropoffLat, dropoffLng } = req.body;

    if (!pickupLat || !pickupLng || !dropoffLat || !dropoffLng) {
      return res.status(400).json({ error: 'Pickup and dropoff coordinates are required' });
    }

    const estimates = await pricingService.getAllFareEstimates(
      parseFloat(pickupLat),
      parseFloat(pickupLng),
      parseFloat(dropoffLat),
      parseFloat(dropoffLng)
    );

    // Get nearby drivers count for availability info
    const nearbyDrivers = await locationService.findNearbyDrivers(
      parseFloat(pickupLat),
      parseFloat(pickupLng),
      5
    );

    const availabilityByType = {
      economy: nearbyDrivers.filter((d) => d.vehicleType === 'economy').length,
      comfort: nearbyDrivers.filter((d) => d.vehicleType === 'comfort').length,
      premium: nearbyDrivers.filter((d) => d.vehicleType === 'premium').length,
      xl: nearbyDrivers.filter((d) => d.vehicleType === 'xl').length,
    };

    res.json({
      estimates: estimates.map((e) => ({
        ...e,
        availableDrivers: availabilityByType[e.vehicleType] || 0,
      })),
    });
  } catch (error) {
    logger.error({ error: error.message, stack: error.stack }, 'Estimate error');
    res.status(500).json({ error: 'Failed to get fare estimate' });
  }
});

// Request a ride - with idempotency to prevent duplicate bookings
router.post(
  '/request',
  authenticate,
  requireRider,
  idempotencyMiddleware({ operation: 'ride_request', ttl: 86400 }),
  async (req, res) => {
    try {
      const { pickupLat, pickupLng, dropoffLat, dropoffLng, vehicleType, pickupAddress, dropoffAddress } = req.body;

      if (!pickupLat || !pickupLng || !dropoffLat || !dropoffLng) {
        return res.status(400).json({ error: 'Pickup and dropoff coordinates are required' });
      }

      // Check if rider already has an active ride
      const activeRide = await query(
        `SELECT id, status FROM rides
         WHERE rider_id = $1 AND status IN ('requested', 'matched', 'driver_arrived', 'picked_up')
         LIMIT 1`,
        [req.user.id]
      );

      if (activeRide.rows.length > 0) {
        logger.warn(
          { riderId: req.user.id, existingRideId: activeRide.rows[0].id },
          'Rider attempted to request ride while having active ride'
        );
        return res.status(409).json({
          error: 'You already have an active ride',
          existingRideId: activeRide.rows[0].id,
          existingRideStatus: activeRide.rows[0].status,
        });
      }

      const ride = await matchingService.requestRide(
        req.user.id,
        parseFloat(pickupLat),
        parseFloat(pickupLng),
        parseFloat(dropoffLat),
        parseFloat(dropoffLng),
        vehicleType || 'economy',
        pickupAddress,
        dropoffAddress
      );

      logger.info(
        { rideId: ride.rideId, riderId: req.user.id },
        'Ride requested successfully'
      );

      res.status(201).json(ride);
    } catch (error) {
      logger.error({ error: error.message, stack: error.stack }, 'Request ride error');
      res.status(500).json({ error: 'Failed to request ride' });
    }
  }
);

// Get ride status
router.get('/:rideId', authenticate, async (req, res) => {
  try {
    const { rideId } = req.params;
    const ride = await matchingService.getRideStatus(rideId);

    if (!ride) {
      return res.status(404).json({ error: 'Ride not found' });
    }

    res.json(ride);
  } catch (error) {
    logger.error({ error: error.message }, 'Get ride error');
    res.status(500).json({ error: 'Failed to get ride status' });
  }
});

// Cancel ride - with idempotency to prevent double-cancel
router.post(
  '/:rideId/cancel',
  authenticate,
  idempotencyMiddleware({ operation: 'ride_cancel', ttl: 3600 }),
  async (req, res) => {
    try {
      const { rideId } = req.params;
      const { reason } = req.body;

      const result = await matchingService.cancelRide(rideId, req.user.userType, reason);

      if (!result.success) {
        return res.status(400).json({ error: result.error });
      }

      res.json(result);
    } catch (error) {
      logger.error({ error: error.message }, 'Cancel ride error');
      res.status(500).json({ error: 'Failed to cancel ride' });
    }
  }
);

// Rate the ride - with idempotency to prevent duplicate ratings
router.post(
  '/:rideId/rate',
  authenticate,
  idempotencyMiddleware({ operation: 'ride_rate', ttl: 86400 }),
  async (req, res) => {
    try {
      const { rideId } = req.params;
      const { rating } = req.body;

      if (!rating || rating < 1 || rating > 5) {
        return res.status(400).json({ error: 'Rating must be between 1 and 5' });
      }

      // Get ride
      const rideResult = await query('SELECT * FROM rides WHERE id = $1', [rideId]);
      if (rideResult.rows.length === 0) {
        return res.status(404).json({ error: 'Ride not found' });
      }

      const ride = rideResult.rows[0];

      // Verify ride is completed
      if (ride.status !== 'completed') {
        return res.status(400).json({ error: 'Can only rate completed rides' });
      }

      // Check if already rated
      if (req.user.userType === 'rider' && ride.driver_rating !== null) {
        return res.status(409).json({ error: 'You have already rated this ride' });
      }
      if (req.user.userType === 'driver' && ride.rider_rating !== null) {
        return res.status(409).json({ error: 'You have already rated this ride' });
      }

      // Update rating based on who is rating
      if (req.user.userType === 'rider' && ride.rider_id === req.user.id) {
        // Rider rating driver
        await query('UPDATE rides SET driver_rating = $1 WHERE id = $2', [rating, rideId]);

        // Update driver's average rating
        await query(
          `UPDATE users SET
           rating = (rating * rating_count + $1) / (rating_count + 1),
           rating_count = rating_count + 1
           WHERE id = $2`,
          [rating, ride.driver_id]
        );

        logger.info({ rideId, rating, driverId: ride.driver_id }, 'Driver rated');
      } else if (req.user.userType === 'driver' && ride.driver_id === req.user.id) {
        // Driver rating rider
        await query('UPDATE rides SET rider_rating = $1 WHERE id = $2', [rating, rideId]);

        // Update rider's average rating
        await query(
          `UPDATE users SET
           rating = (rating * rating_count + $1) / (rating_count + 1),
           rating_count = rating_count + 1
           WHERE id = $2`,
          [rating, ride.rider_id]
        );

        logger.info({ rideId, rating, riderId: ride.rider_id }, 'Rider rated');
      } else {
        return res.status(403).json({ error: 'Not authorized to rate this ride' });
      }

      res.json({ success: true });
    } catch (error) {
      logger.error({ error: error.message }, 'Rate ride error');
      res.status(500).json({ error: 'Failed to rate ride' });
    }
  }
);

// Get ride history
router.get('/', authenticate, async (req, res) => {
  try {
    const { limit = 20, offset = 0 } = req.query;

    let queryText;
    let queryParams;

    if (req.user.userType === 'rider') {
      queryText = `
        SELECT r.*, u.name as driver_name, d.vehicle_make, d.vehicle_model, d.vehicle_color
        FROM rides r
        LEFT JOIN users u ON r.driver_id = u.id
        LEFT JOIN drivers d ON r.driver_id = d.user_id
        WHERE r.rider_id = $1
        ORDER BY r.requested_at DESC
        LIMIT $2 OFFSET $3
      `;
      queryParams = [req.user.id, parseInt(limit), parseInt(offset)];
    } else {
      queryText = `
        SELECT r.*, u.name as rider_name
        FROM rides r
        JOIN users u ON r.rider_id = u.id
        WHERE r.driver_id = $1
        ORDER BY r.requested_at DESC
        LIMIT $2 OFFSET $3
      `;
      queryParams = [req.user.id, parseInt(limit), parseInt(offset)];
    }

    const result = await query(queryText, queryParams);

    res.json({
      rides: result.rows.map((r) => ({
        id: r.id,
        status: r.status,
        pickup: {
          lat: parseFloat(r.pickup_lat),
          lng: parseFloat(r.pickup_lng),
          address: r.pickup_address,
        },
        dropoff: {
          lat: parseFloat(r.dropoff_lat),
          lng: parseFloat(r.dropoff_lng),
          address: r.dropoff_address,
        },
        vehicleType: r.vehicle_type,
        fare: r.final_fare_cents || r.estimated_fare_cents,
        surgeMultiplier: parseFloat(r.surge_multiplier),
        driver: r.driver_name
          ? {
              name: r.driver_name,
              vehicle: `${r.vehicle_color} ${r.vehicle_make} ${r.vehicle_model}`,
            }
          : null,
        rider: r.rider_name ? { name: r.rider_name } : null,
        requestedAt: r.requested_at,
        completedAt: r.completed_at,
      })),
    });
  } catch (error) {
    logger.error({ error: error.message }, 'Get rides error');
    res.status(500).json({ error: 'Failed to get ride history' });
  }
});

// Get nearby drivers (for map display)
router.get('/nearby/drivers', authenticate, requireRider, async (req, res) => {
  try {
    const { lat, lng, radius = 5 } = req.query;

    if (!lat || !lng) {
      return res.status(400).json({ error: 'Location coordinates are required' });
    }

    const drivers = await locationService.findNearbyDrivers(
      parseFloat(lat),
      parseFloat(lng),
      parseFloat(radius)
    );

    // Return simplified driver info for privacy
    res.json({
      drivers: drivers.map((d) => ({
        id: d.id,
        lat: d.lat,
        lng: d.lng,
        vehicleType: d.vehicleType,
      })),
    });
  } catch (error) {
    logger.error({ error: error.message }, 'Get nearby drivers error');
    res.status(500).json({ error: 'Failed to get nearby drivers' });
  }
});

// Get surge info
router.get('/surge/info', authenticate, async (req, res) => {
  try {
    const { lat, lng } = req.query;

    if (!lat || !lng) {
      return res.status(400).json({ error: 'Location coordinates are required' });
    }

    const surgeInfo = await pricingService.getSurgeInfo(parseFloat(lat), parseFloat(lng));

    res.json(surgeInfo);
  } catch (error) {
    logger.error({ error: error.message }, 'Get surge info error');
    res.status(500).json({ error: 'Failed to get surge info' });
  }
});

export default router;
