import { Router } from 'express';
import { register, login, logout, getUserDevices, deactivateDevice } from '../services/auth.js';
import { authenticateRequest } from '../middleware/auth.js';
import { loginRateLimiter, deviceRegistrationRateLimiter } from '../shared/rate-limiter.js';
import { createLogger } from '../shared/logger.js';
import { authAttempts } from '../shared/metrics.js';

const router = Router();
const logger = createLogger('auth-routes');

router.post('/register', async (req, res) => {
  try {
    const { username, email, password, displayName, deviceName, deviceType } = req.body;

    if (!username || !email || !password) {
      return res.status(400).json({ error: 'Username, email, and password are required' });
    }

    const result = await register(username, email, password, displayName, deviceName, deviceType);

    logger.info({ userId: result.user.id, username }, 'User registered');
    authAttempts.inc({ result: 'success' });

    res.status(201).json(result);
  } catch (error) {
    logger.error({ error }, 'Registration error');
    if (error.code === '23505') {
      return res.status(409).json({ error: 'Username or email already exists' });
    }
    res.status(500).json({ error: 'Registration failed' });
  }
});

// Rate limited: 5 attempts per 15 minutes per IP
router.post('/login', loginRateLimiter, async (req, res) => {
  try {
    const { usernameOrEmail, password, deviceName, deviceType } = req.body;

    if (!usernameOrEmail || !password) {
      return res.status(400).json({ error: 'Username/email and password are required' });
    }

    const result = await login(usernameOrEmail, password, deviceName, deviceType);

    logger.info({ userId: result.user.id }, 'User logged in');
    authAttempts.inc({ result: 'success' });

    res.json(result);
  } catch (error) {
    if (error.message === 'Invalid credentials') {
      logger.warn({ usernameOrEmail, ip: req.ip }, 'Failed login attempt');
      authAttempts.inc({ result: 'failure' });
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    logger.error({ error }, 'Login error');
    res.status(500).json({ error: 'Login failed' });
  }
});

router.post('/logout', authenticateRequest, async (req, res) => {
  try {
    const token = req.headers.authorization?.substring(7);
    await logout(token);

    logger.info({ userId: req.user.id }, 'User logged out');

    res.json({ message: 'Logged out successfully' });
  } catch (error) {
    logger.error({ error, userId: req.user?.id }, 'Logout error');
    res.status(500).json({ error: 'Logout failed' });
  }
});

router.get('/me', authenticateRequest, async (req, res) => {
  res.json({
    user: req.user,
    deviceId: req.deviceId,
  });
});

router.get('/devices', authenticateRequest, async (req, res) => {
  try {
    const devices = await getUserDevices(req.user.id);
    res.json({ devices });
  } catch (error) {
    logger.error({ error, userId: req.user?.id }, 'Get devices error');
    res.status(500).json({ error: 'Failed to get devices' });
  }
});

router.delete('/devices/:deviceId', authenticateRequest, async (req, res) => {
  try {
    await deactivateDevice(req.user.id, req.params.deviceId);

    logger.info({ userId: req.user.id, deviceId: req.params.deviceId }, 'Device deactivated');

    res.json({ message: 'Device deactivated' });
  } catch (error) {
    logger.error({ error, userId: req.user?.id }, 'Deactivate device error');
    res.status(500).json({ error: 'Failed to deactivate device' });
  }
});

export default router;
