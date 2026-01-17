import { Router } from 'express';
import { register, login, logout, getUserDevices, deactivateDevice } from '../services/auth.js';
import { authenticateRequest } from '../middleware/auth.js';

const router = Router();

router.post('/register', async (req, res) => {
  try {
    const { username, email, password, displayName, deviceName, deviceType } = req.body;

    if (!username || !email || !password) {
      return res.status(400).json({ error: 'Username, email, and password are required' });
    }

    const result = await register(username, email, password, displayName, deviceName, deviceType);
    res.status(201).json(result);
  } catch (error) {
    console.error('Registration error:', error);
    if (error.code === '23505') {
      return res.status(409).json({ error: 'Username or email already exists' });
    }
    res.status(500).json({ error: 'Registration failed' });
  }
});

router.post('/login', async (req, res) => {
  try {
    const { usernameOrEmail, password, deviceName, deviceType } = req.body;

    if (!usernameOrEmail || !password) {
      return res.status(400).json({ error: 'Username/email and password are required' });
    }

    const result = await login(usernameOrEmail, password, deviceName, deviceType);
    res.json(result);
  } catch (error) {
    console.error('Login error:', error);
    if (error.message === 'Invalid credentials') {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    res.status(500).json({ error: 'Login failed' });
  }
});

router.post('/logout', authenticateRequest, async (req, res) => {
  try {
    const token = req.headers.authorization?.substring(7);
    await logout(token);
    res.json({ message: 'Logged out successfully' });
  } catch (error) {
    console.error('Logout error:', error);
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
    console.error('Get devices error:', error);
    res.status(500).json({ error: 'Failed to get devices' });
  }
});

router.delete('/devices/:deviceId', authenticateRequest, async (req, res) => {
  try {
    await deactivateDevice(req.user.id, req.params.deviceId);
    res.json({ message: 'Device deactivated' });
  } catch (error) {
    console.error('Deactivate device error:', error);
    res.status(500).json({ error: 'Failed to deactivate device' });
  }
});

export default router;
