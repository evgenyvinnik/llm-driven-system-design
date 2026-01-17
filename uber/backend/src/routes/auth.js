import { Router } from 'express';
import authService from '../services/authService.js';
import { authenticate } from '../middleware/auth.js';

const router = Router();

// Register rider
router.post('/register/rider', async (req, res) => {
  try {
    const { email, password, name, phone } = req.body;

    if (!email || !password || !name) {
      return res.status(400).json({ error: 'Email, password, and name are required' });
    }

    const result = await authService.register(email, password, name, phone, 'rider');

    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }

    res.status(201).json(result);
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// Register driver
router.post('/register/driver', async (req, res) => {
  try {
    const { email, password, name, phone, vehicle } = req.body;

    if (!email || !password || !name || !vehicle) {
      return res.status(400).json({ error: 'Email, password, name, and vehicle info are required' });
    }

    const result = await authService.registerDriver(email, password, name, phone, vehicle);

    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }

    res.status(201).json(result);
  } catch (error) {
    console.error('Driver registration error:', error);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// Login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const result = await authService.login(email, password);

    if (!result.success) {
      return res.status(401).json({ error: result.error });
    }

    res.json(result);
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

// Get current user
router.get('/me', authenticate, (req, res) => {
  res.json({ user: req.user });
});

// Logout
router.post('/logout', authenticate, async (req, res) => {
  try {
    await authService.logout(req.token);
    res.json({ success: true });
  } catch (error) {
    console.error('Logout error:', error);
    res.status(500).json({ error: 'Logout failed' });
  }
});

export default router;
