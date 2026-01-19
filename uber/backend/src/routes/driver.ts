import { Router, Response } from 'express';
import { authenticate, requireDriver } from '../middleware/auth.js';
import locationService from '../services/locationService.js';
import matchingService from '../services/matching/index.js';
import { query } from '../utils/db.js';
import type { AuthenticatedRequest } from '../types/index.js';

const router = Router();

// Request body interfaces
interface LocationBody {
  lat: number;
  lng: number;
}

interface CompleteRideBody {
  finalDistanceMeters?: number;
}

// Route params interfaces
interface RideParams {
  rideId: string;
}

// Query interfaces
interface EarningsQuery {
  period?: 'today' | 'week' | 'month';
}

// Database row types
interface ActiveRideRow {
  id: string;
  status: string;
  pickup_lat: string;
  pickup_lng: string;
  pickup_address: string | null;
  dropoff_lat: string;
  dropoff_lng: string;
  dropoff_address: string | null;
  estimated_fare_cents: number;
}

interface EarningsRow {
  total_rides: string;
  total_earnings: string;
  avg_fare: string;
  total_distance: string;
  total_duration: string;
}

interface HourlyEarningsRow {
  hour: Date;
  rides: string;
  earnings: string;
}

interface DriverProfileRow {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  rating: string;
  rating_count: number;
  vehicle_type: string;
  vehicle_make: string;
  vehicle_model: string;
  vehicle_color: string;
  license_plate: string;
  total_rides: number;
  total_earnings_cents: number;
  is_online: boolean;
  is_available: boolean;
  created_at: Date;
}

// Update location
router.post(
  '/location',
  authenticate as never,
  requireDriver as never,
  (async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const { lat, lng } = req.body as LocationBody;

      if (lat === undefined || lng === undefined) {
        res.status(400).json({ error: 'Location coordinates are required' });
        return;
      }

      await locationService.updateDriverLocation(req.user.id, parseFloat(String(lat)), parseFloat(String(lng)));

      res.json({ success: true });
    } catch (error) {
      console.error('Update location error:', error);
      res.status(500).json({ error: 'Failed to update location' });
    }
  }) as never
);

// Go online
router.post(
  '/online',
  authenticate as never,
  requireDriver as never,
  (async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const { lat, lng } = req.body as LocationBody;

      if (lat === undefined || lng === undefined) {
        res.status(400).json({ error: 'Location coordinates are required' });
        return;
      }

      await locationService.setDriverAvailability(req.user.id, true, parseFloat(String(lat)), parseFloat(String(lng)));

      res.json({ success: true, status: 'online' });
    } catch (error) {
      console.error('Go online error:', error);
      res.status(500).json({ error: 'Failed to go online' });
    }
  }) as never
);

// Go offline
router.post(
  '/offline',
  authenticate as never,
  requireDriver as never,
  (async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      await locationService.setDriverAvailability(req.user.id, false);

      res.json({ success: true, status: 'offline' });
    } catch (error) {
      console.error('Go offline error:', error);
      res.status(500).json({ error: 'Failed to go offline' });
    }
  }) as never
);

// Get driver status
router.get(
  '/status',
  authenticate as never,
  requireDriver as never,
  (async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const status = await locationService.getDriverStatus(req.user.id);
      const location = await locationService.getDriverLocation(req.user.id);

      // Check for active ride
      const activeRide = await query<ActiveRideRow>(
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
  }) as never
);

// Accept a ride
router.post(
  '/rides/:rideId/accept',
  authenticate as never,
  requireDriver as never,
  (async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const { rideId } = req.params as unknown as RideParams;

      const result = await matchingService.acceptRide(rideId, req.user.id);

      if (!result.success) {
        res.status(400).json({ error: result.error });
        return;
      }

      res.json(result);
    } catch (error) {
      console.error('Accept ride error:', error);
      res.status(500).json({ error: 'Failed to accept ride' });
    }
  }) as never
);

// Decline a ride
router.post(
  '/rides/:rideId/decline',
  authenticate as never,
  requireDriver as never,
  (async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      // Just acknowledge - the matching service will try next driver
      res.json({ success: true });
    } catch (error) {
      console.error('Decline ride error:', error);
      res.status(500).json({ error: 'Failed to decline ride' });
    }
  }) as never
);

// Notify arrival at pickup
router.post(
  '/rides/:rideId/arrived',
  authenticate as never,
  requireDriver as never,
  (async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const { rideId } = req.params as unknown as RideParams;

      const result = await matchingService.driverArrived(rideId, req.user.id);

      res.json(result);
    } catch (error) {
      console.error('Arrive error:', error);
      res.status(500).json({ error: 'Failed to update arrival' });
    }
  }) as never
);

// Start the ride
router.post(
  '/rides/:rideId/start',
  authenticate as never,
  requireDriver as never,
  (async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const { rideId } = req.params as unknown as RideParams;

      const result = await matchingService.startRide(rideId, req.user.id);

      res.json(result);
    } catch (error) {
      console.error('Start ride error:', error);
      res.status(500).json({ error: 'Failed to start ride' });
    }
  }) as never
);

// Complete the ride
router.post(
  '/rides/:rideId/complete',
  authenticate as never,
  requireDriver as never,
  (async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const { rideId } = req.params as unknown as RideParams;
      const { finalDistanceMeters } = req.body as CompleteRideBody;

      const result = await matchingService.completeRide(rideId, req.user.id, finalDistanceMeters || null);

      if (!result.success) {
        res.status(400).json({ error: result.error });
        return;
      }

      res.json(result);
    } catch (error) {
      console.error('Complete ride error:', error);
      res.status(500).json({ error: 'Failed to complete ride' });
    }
  }) as never
);

// Get earnings
router.get(
  '/earnings',
  authenticate as never,
  requireDriver as never,
  (async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const { period = 'today' } = req.query as unknown as EarningsQuery;

      let dateFilter: Date;
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

      const result = await query<EarningsRow>(
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
      const hourlyResult = await query<HourlyEarningsRow>(
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
  }) as never
);

// Get driver profile
router.get(
  '/profile',
  authenticate as never,
  requireDriver as never,
  (async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const result = await query<DriverProfileRow>(
        `SELECT u.*, d.*
         FROM users u
         JOIN drivers d ON u.id = d.user_id
         WHERE u.id = $1`,
        [req.user.id]
      );

      if (result.rows.length === 0) {
        res.status(404).json({ error: 'Driver not found' });
        return;
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
  }) as never
);

export default router;
