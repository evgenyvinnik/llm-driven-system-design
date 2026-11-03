import { Router, Request, Response } from 'express';
import {
  createSession,
  deleteSession,
  getUserByEmail,
  createUser,
  verifyPassword,
  getDriverByUserId,
  onboardDriver,
  onboardRestaurantOwner,
  User,
  Driver,
} from '../services/auth.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

const VEHICLE_TYPES = ['car', 'bike', 'scooter', 'walk'];

interface UserWithDriverProfile extends User {
  driverProfile?: Driver | null;
}

// Register. Always creates a customer: any `role` in the body is ignored, and
// drivers/restaurant owners onboard through the endpoints at the bottom.
router.post('/register', async (req: Request, res: Response): Promise<void> => {
  try {
    const { email, password, name, phone } = req.body;

    if (!email || !password || !name) {
      res.status(400).json({ error: 'Email, password, and name are required' });
      return;
    }

    // Check if user exists
    const existing = await getUserByEmail(email);
    if (existing) {
      res.status(400).json({ error: 'Email already registered' });
      return;
    }

    // Create user
    const user = await createUser(email, password, name, phone);

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
router.post('/login', async (req: Request, res: Response): Promise<void> => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      res.status(400).json({ error: 'Email and password are required' });
      return;
    }

    const user = await getUserByEmail(email);
    if (!user) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }

    const valid = await verifyPassword(password, user.password_hash!);
    if (!valid) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }

    const sessionId = await createSession(user.id);

    res.cookie('session', sessionId, {
      httpOnly: true,
      maxAge: 7 * 24 * 60 * 60 * 1000,
      sameSite: 'lax',
    });

    // Don't send password hash
    const userResponse: Partial<User> = { ...user };
    delete userResponse.password_hash;

    res.json({ user: userResponse });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Failed to login' });
  }
});

// Logout
router.post('/logout', async (req: Request, res: Response): Promise<void> => {
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
router.get('/me', requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const user: UserWithDriverProfile = { ...req.user! };

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

// Customer onboarding as a driver: creates the driver profile and sets role `driver`
router.post('/become-driver', requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const { vehicleType, licensePlate } = req.body;

    if (!VEHICLE_TYPES.includes(vehicleType)) {
      res.status(400).json({ error: `Vehicle type must be one of: ${VEHICLE_TYPES.join(', ')}` });
      return;
    }

    // Check if already a driver
    const existing = await getDriverByUserId(req.user!.id);
    if (existing) {
      res.status(400).json({ error: 'Already registered as driver' });
      return;
    }

    const result = await onboardDriver(req.user!.id, vehicleType, licensePlate);
    if (!result) {
      res.status(403).json({ error: 'Only customer accounts can sign up to deliver' });
      return;
    }

    res.json(result);
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      res.status(400).json({ error: 'Already registered as driver' });
      return;
    }
    console.error('Become driver error:', err);
    res.status(500).json({ error: 'Failed to register as driver' });
  }
});

// Customer onboarding as a restaurant owner: sets role `restaurant_owner`
router.post(
  '/become-restaurant-owner',
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const user = await onboardRestaurantOwner(req.user!.id);
      if (!user) {
        res.status(403).json({ error: 'Only customer accounts can sign up as restaurant owners' });
        return;
      }

      res.json({ user });
    } catch (err) {
      console.error('Become restaurant owner error:', err);
      res.status(500).json({ error: 'Failed to register as restaurant owner' });
    }
  }
);

export default router;
