import { Router } from 'express';
import {
  createSession,
  deleteSession,
  getUserByEmail,
  createUser,
  verifyPassword,
  getDriverByUserId,
  createDriverProfile,
} from '../services/auth.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

// Register
router.post('/register', async (req, res) => {
  try {
    const { email, password, name, phone, role = 'customer' } = req.body;

    if (!email || !password || !name) {
      return res.status(400).json({ error: 'Email, password, and name are required' });
    }

    // Check if user exists
    const existing = await getUserByEmail(email);
    if (existing) {
      return res.status(400).json({ error: 'Email already registered' });
    }

    // Create user
    const user = await createUser(email, password, name, phone, role);

    // Create session
    const sessionId = await createSession(user.id);

    res.cookie('session', sessionId, {
      httpOnly: true,
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
      sameSite: 'lax',
    });

    res.json({ user });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Failed to register' });
  }
});

// Login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const user = await getUserByEmail(email);
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const valid = await verifyPassword(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const sessionId = await createSession(user.id);

    res.cookie('session', sessionId, {
      httpOnly: true,
      maxAge: 7 * 24 * 60 * 60 * 1000,
      sameSite: 'lax',
    });

    // Don't send password hash
    delete user.password_hash;

    res.json({ user });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Failed to login' });
  }
});

// Logout
router.post('/logout', async (req, res) => {
  try {
    const sessionId = req.cookies?.session;
    if (sessionId) {
      await deleteSession(sessionId);
    }
    res.clearCookie('session');
    res.json({ success: true });
  } catch (err) {
    console.error('Logout error:', err);
    res.status(500).json({ error: 'Failed to logout' });
  }
});

// Get current user
router.get('/me', requireAuth, async (req, res) => {
  try {
    const user = { ...req.user };

    // If driver, include driver profile
    if (user.role === 'driver') {
      const driverProfile = await getDriverByUserId(user.id);
      user.driverProfile = driverProfile;
    }

    res.json({ user });
  } catch (err) {
    console.error('Get me error:', err);
    res.status(500).json({ error: 'Failed to get user' });
  }
});

// Register as driver (for existing users)
router.post('/become-driver', requireAuth, async (req, res) => {
  try {
    const { vehicleType, licensePlate } = req.body;

    if (!vehicleType) {
      return res.status(400).json({ error: 'Vehicle type is required' });
    }

    // Check if already a driver
    const existing = await getDriverByUserId(req.user.id);
    if (existing) {
      return res.status(400).json({ error: 'Already registered as driver' });
    }

    const driver = await createDriverProfile(req.user.id, vehicleType, licensePlate);

    res.json({ driver });
  } catch (err) {
    console.error('Become driver error:', err);
    res.status(500).json({ error: 'Failed to register as driver' });
  }
});

export default router;
