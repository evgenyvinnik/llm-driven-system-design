import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { deviceService } from '../services/deviceService.js';
import { CreateDeviceRequest, UpdateDeviceRequest } from '../types/index.js';

const router = Router();

// All routes require authentication
router.use(requireAuth);

/**
 * GET /api/devices
 * Get all devices for the current user
 */
router.get('/', async (req, res) => {
  try {
    const devices = await deviceService.getDevicesByUser(req.session.userId!);
    res.json(devices);
  } catch (error) {
    console.error('Get devices error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/devices
 * Create a new device
 */
router.post('/', async (req, res) => {
  try {
    const data: CreateDeviceRequest = req.body;

    if (!data.device_type || !data.name) {
      return res.status(400).json({ error: 'Device type and name are required' });
    }

    const validTypes = ['airtag', 'iphone', 'macbook', 'ipad', 'airpods'];
    if (!validTypes.includes(data.device_type)) {
      return res.status(400).json({ error: 'Invalid device type' });
    }

    const device = await deviceService.createDevice(req.session.userId!, data);
    res.status(201).json(device);
  } catch (error) {
    console.error('Create device error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/devices/:id
 * Get a specific device
 */
router.get('/:id', async (req, res) => {
  try {
    const device = await deviceService.getDevice(req.params.id, req.session.userId!);

    if (!device) {
      return res.status(404).json({ error: 'Device not found' });
    }

    res.json(device);
  } catch (error) {
    console.error('Get device error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * PATCH /api/devices/:id
 * Update a device
 */
router.patch('/:id', async (req, res) => {
  try {
    const data: UpdateDeviceRequest = req.body;
    const device = await deviceService.updateDevice(
      req.params.id,
      req.session.userId!,
      data
    );

    if (!device) {
      return res.status(404).json({ error: 'Device not found' });
    }

    res.json(device);
  } catch (error) {
    console.error('Update device error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * DELETE /api/devices/:id
 * Delete a device
 */
router.delete('/:id', async (req, res) => {
  try {
    const deleted = await deviceService.deleteDevice(req.params.id, req.session.userId!);

    if (!deleted) {
      return res.status(404).json({ error: 'Device not found' });
    }

    res.json({ message: 'Device deleted successfully' });
  } catch (error) {
    console.error('Delete device error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/devices/:id/play-sound
 * Simulate playing a sound on the device
 */
router.post('/:id/play-sound', async (req, res) => {
  try {
    const device = await deviceService.getDevice(req.params.id, req.session.userId!);

    if (!device) {
      return res.status(404).json({ error: 'Device not found' });
    }

    // In a real system, this would trigger the device to play a sound
    // For demo purposes, we just return success
    res.json({
      message: `Playing sound on ${device.name}`,
      device_id: device.id,
      device_name: device.name,
    });
  } catch (error) {
    console.error('Play sound error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
