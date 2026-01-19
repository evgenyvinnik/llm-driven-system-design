import { Router, Response } from 'express';
import { query } from '../../utils/db.js';
import { requireAuth, AuthenticatedRequest } from '../../middleware/auth.js';
import { activityLogger as log, logError, ErrorWithCode } from '../../shared/logger.js';

const router = Router();

// Activity analysis endpoints
// These endpoints provide statistics and analytics for activities

// Get activity summary statistics (e.g., splits, zones)
router.get('/:id/analysis', requireAuth, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;

    // Check activity ownership
    const activityResult = await query<{ user_id: string; type: string; distance: number; elapsed_time: number }>(
      'SELECT user_id, type, distance, elapsed_time FROM activities WHERE id = $1',
      [id]
    );

    if (activityResult.rows.length === 0) {
      res.status(404).json({ error: 'Activity not found' });
      return;
    }

    const activity = activityResult.rows[0];

    // Get GPS points for analysis
    const gpsResult = await query<{
      latitude: number;
      longitude: number;
      altitude: number | null;
      speed: number | null;
      heart_rate: number | null;
    }>(
      `SELECT latitude, longitude, altitude, speed, heart_rate
       FROM gps_points
       WHERE activity_id = $1
       ORDER BY point_index`,
      [id]
    );

    const points = gpsResult.rows;

    // Calculate basic analysis
    const altitudes = points.map(p => p.altitude).filter((a): a is number => a !== null);
    const speeds = points.map(p => p.speed).filter((s): s is number => s !== null);
    const heartRates = points.map(p => p.heart_rate).filter((hr): hr is number => hr !== null);

    const analysis = {
      elevation: {
        min: altitudes.length > 0 ? Math.min(...altitudes) : null,
        max: altitudes.length > 0 ? Math.max(...altitudes) : null,
        avg: altitudes.length > 0 ? altitudes.reduce((a, b) => a + b, 0) / altitudes.length : null
      },
      speed: {
        min: speeds.length > 0 ? Math.min(...speeds) : null,
        max: speeds.length > 0 ? Math.max(...speeds) : null,
        avg: speeds.length > 0 ? speeds.reduce((a, b) => a + b, 0) / speeds.length : null
      },
      heartRate: {
        min: heartRates.length > 0 ? Math.min(...heartRates) : null,
        max: heartRates.length > 0 ? Math.max(...heartRates) : null,
        avg: heartRates.length > 0 ? heartRates.reduce((a, b) => a + b, 0) / heartRates.length : null
      },
      pointCount: points.length
    };

    res.json({ analysis });
  } catch (error) {
    logError(log, error as ErrorWithCode, 'Get activity analysis error');
    res.status(500).json({ error: 'Failed to get activity analysis' });
  }
});

export default router;
