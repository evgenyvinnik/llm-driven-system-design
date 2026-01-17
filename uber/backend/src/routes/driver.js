import { Router } from 'express';
import { authenticate, requireDriver } from '../middleware/auth.js';
import locationService from '../services/locationService.js';
import matchingService from '../services/matchingService.js';
import { query } from '../utils/db.js';

const router = Router();

// Update location
router.post('/location', authenticate, requireDriver, async (req, res) => {
  try {
    const { lat, lng } = req.body;

    if (lat === undefined || lng === undefined) {
      return res.status(400).json({ error: 'Location coordinates are required' });
    }

    await locationService.updateDriverLocation(req.user.id, parseFloat(lat), parseFloat(lng));

    res.json({ success: true });
  } catch (error) {
    console.error('Update location error:', error);
    res.status(500).json({ error: 'Failed to update location' });
  }
});

// Go online
router.post('/online', authenticate, requireDriver, async (req, res) => {
  try {
    const { lat, lng } = req.body;

    if (lat === undefined || lng === undefined) {
      return res.status(400).json({ error: 'Location coordinates are required' });
    }

    await locationService.setDriverAvailability(req.user.id, true, parseFloat(lat), parseFloat(lng));

    res.json({ success: true, status: 'online' });
  } catch (error) {
    console.error('Go online error:', error);
    res.status(500).json({ error: 'Failed to go online' });
  }
});

// Go offline
router.post('/offline', authenticate, requireDriver, async (req, res) => {
  try {
    await locationService.setDriverAvailability(req.user.id, false);

    res.json({ success: true, status: 'offline' });
  } catch (error) {
    console.error('Go offline error:', error);
    res.status(500).json({ error: 'Failed to go offline' });
  }
});

// Get driver status
router.get('/status', authenticate, requireDriver, async (req, res) => {
  try {
    const status = await locationService.getDriverStatus(req.user.id);
    const location = await locationService.getDriverLocation(req.user.id);

    // Check for active ride
    const activeRide = await query(
      `SELECT * FROM rides WHERE driver_id = $1 AND status IN ('matched', 'driver_arrived', 'picked_up')`,
      [req.user.id]
    );

    res.json({
      status,
      location,
      activeRide: activeRide.rows.length > 0 ? {
        id: activeRide.rows[0].id,
        status: activeRide.rows[0].status,
        pickup: {
          lat: parseFloat(activeRide.rows[0].pickup_lat),
          lng: parseFloat(activeRide.rows[0].pickup_lng),
          address: activeRide.rows[0].pickup_address,
        },
        dropoff: {
          lat: parseFloat(activeRide.rows[0].dropoff_lat),
          lng: parseFloat(activeRide.rows[0].dropoff_lng),
          address: activeRide.rows[0].dropoff_address,
        },
        estimatedFare: activeRide.rows[0].estimated_fare_cents,
      } : null,
    });
  } catch (error) {
    console.error('Get status error:', error);
    res.status(500).json({ error: 'Failed to get status' });
  }
});

// Accept a ride
router.post('/rides/:rideId/accept', authenticate, requireDriver, async (req, res) => {
  try {
    const { rideId } = req.params;

    const result = await matchingService.acceptRide(rideId, req.user.id);

    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }

    res.json(result);
  } catch (error) {
    console.error('Accept ride error:', error);
    res.status(500).json({ error: 'Failed to accept ride' });
  }
});

// Decline a ride
router.post('/rides/:rideId/decline', authenticate, requireDriver, async (req, res) => {
  try {
    const { rideId } = req.params;

    // Just acknowledge - the matching service will try next driver
    res.json({ success: true });
  } catch (error) {
    console.error('Decline ride error:', error);
    res.status(500).json({ error: 'Failed to decline ride' });
  }
});

// Notify arrival at pickup
router.post('/rides/:rideId/arrived', authenticate, requireDriver, async (req, res) => {
  try {
    const { rideId } = req.params;

    const result = await matchingService.driverArrived(rideId, req.user.id);

    res.json(result);
  } catch (error) {
    console.error('Arrive error:', error);
    res.status(500).json({ error: 'Failed to update arrival' });
  }
});

// Start the ride
router.post('/rides/:rideId/start', authenticate, requireDriver, async (req, res) => {
  try {
    const { rideId } = req.params;

    const result = await matchingService.startRide(rideId, req.user.id);

    res.json(result);
  } catch (error) {
    console.error('Start ride error:', error);
    res.status(500).json({ error: 'Failed to start ride' });
  }
});

// Complete the ride
router.post('/rides/:rideId/complete', authenticate, requireDriver, async (req, res) => {
  try {
    const { rideId } = req.params;
    const { finalDistanceMeters } = req.body;

    const result = await matchingService.completeRide(rideId, req.user.id, finalDistanceMeters);

    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }

    res.json(result);
  } catch (error) {
    console.error('Complete ride error:', error);
    res.status(500).json({ error: 'Failed to complete ride' });
  }
});

// Get earnings
router.get('/earnings', authenticate, requireDriver, async (req, res) => {
  try {
    const { period = 'today' } = req.query;

    let dateFilter;
    const now = new Date();

    switch (period) {
      case 'today':
        dateFilter = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        break;
      case 'week':
        dateFilter = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        break;
      case 'month':
        dateFilter = new Date(now.getFullYear(), now.getMonth(), 1);
        break;
      default:
        dateFilter = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    }

    const result = await query(
      `SELECT
         COUNT(*) as total_rides,
         COALESCE(SUM(final_fare_cents), 0) as total_earnings,
         COALESCE(AVG(final_fare_cents), 0) as avg_fare,
         COALESCE(SUM(distance_meters), 0) as total_distance,
         COALESCE(SUM(duration_seconds), 0) as total_duration
       FROM rides
       WHERE driver_id = $1 AND status = 'completed' AND completed_at >= $2`,
      [req.user.id, dateFilter]
    );

    const stats = result.rows[0];

    // Get hourly breakdown for today
    const hourlyResult = await query(
      `SELECT
         DATE_TRUNC('hour', completed_at) as hour,
         COUNT(*) as rides,
         SUM(final_fare_cents) as earnings
       FROM rides
       WHERE driver_id = $1 AND status = 'completed' AND completed_at >= $2
       GROUP BY DATE_TRUNC('hour', completed_at)
       ORDER BY hour`,
      [req.user.id, dateFilter]
    );

    res.json({
      period,
      totalRides: parseInt(stats.total_rides),
      totalEarnings: parseInt(stats.total_earnings),
      averageFare: Math.round(parseFloat(stats.avg_fare)),
      totalDistanceKm: Math.round(parseInt(stats.total_distance) / 1000),
      totalHours: Math.round(parseInt(stats.total_duration) / 3600 * 10) / 10,
      hourlyBreakdown: hourlyResult.rows.map((h) => ({
        hour: h.hour,
        rides: parseInt(h.rides),
        earnings: parseInt(h.earnings),
      })),
    });
  } catch (error) {
    console.error('Get earnings error:', error);
    res.status(500).json({ error: 'Failed to get earnings' });
  }
});

// Get driver profile
router.get('/profile', authenticate, requireDriver, async (req, res) => {
  try {
    const result = await query(
      `SELECT u.*, d.*
       FROM users u
       JOIN drivers d ON u.id = d.user_id
       WHERE u.id = $1`,
      [req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Driver not found' });
    }

    const driver = result.rows[0];

    res.json({
      id: driver.id,
      name: driver.name,
      email: driver.email,
      phone: driver.phone,
      rating: parseFloat(driver.rating),
      ratingCount: driver.rating_count,
      vehicle: {
        type: driver.vehicle_type,
        make: driver.vehicle_make,
        model: driver.vehicle_model,
        color: driver.vehicle_color,
        licensePlate: driver.license_plate,
      },
      stats: {
        totalRides: driver.total_rides,
        totalEarnings: driver.total_earnings_cents,
        isOnline: driver.is_online,
        isAvailable: driver.is_available,
      },
      createdAt: driver.created_at,
    });
  } catch (error) {
    console.error('Get profile error:', error);
    res.status(500).json({ error: 'Failed to get profile' });
  }
});

export default router;
