import { Router } from 'express';
import { requireAdmin } from '../middleware/auth.js';
import { deviceService } from '../services/deviceService.js';
import { locationService } from '../services/locationService.js';
import { lostModeService } from '../services/lostModeService.js';
import { notificationService } from '../services/notificationService.js';
import { antiStalkingService } from '../services/antiStalkingService.js';
import { userService } from '../services/userService.js';

const router = Router();

// All routes require admin authentication
router.use(requireAdmin);

/**
 * GET /api/admin/stats
 * Get overall system statistics
 */
router.get('/stats', async (req, res) => {
  try {
    const [users, devices, reports, lostMode, notifications, antiStalking] =
      await Promise.all([
        userService.getUserStats(),
        deviceService.getDeviceStats(),
        locationService.getReportStats(),
        lostModeService.getLostModeStats(),
        notificationService.getNotificationStats(),
        antiStalkingService.getAntiStalkingStats(),
      ]);

    res.json({
      users,
      devices,
      reports,
      lostMode,
      notifications,
      antiStalking,
    });
  } catch (error) {
    console.error('Get stats error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/admin/users
 * Get all users
 */
router.get('/users', async (req, res) => {
  try {
    const users = await userService.getAllUsers();
    res.json(users);
  } catch (error) {
    console.error('Get users error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/admin/devices
 * Get all devices
 */
router.get('/devices', async (req, res) => {
  try {
    const devices = await deviceService.getAllDevices();
    res.json(devices);
  } catch (error) {
    console.error('Get devices error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/admin/lost-devices
 * Get all devices in lost mode
 */
router.get('/lost-devices', async (req, res) => {
  try {
    const devices = await lostModeService.getAllLostDevices();
    res.json(devices);
  } catch (error) {
    console.error('Get lost devices error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
