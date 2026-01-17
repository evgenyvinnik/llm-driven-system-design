import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { UserService } from '../services/userService.js';
import { requireAuth } from '../middleware/auth.js';

/**
 * Authentication routes for user registration, login, logout, and session management.
 * Uses bcrypt for password hashing and express-session for session storage.
 */
const router = Router();
const userService = new UserService();

/**
 * POST /api/auth/register
 * Registers a new user account with email/password authentication.
 * Validates age (18+), email uniqueness, and required fields.
 * Automatically logs in the user by setting session cookie.
 */
router.post('/register', async (req: Request, res: Response) => {
  try {
    const { email, password, name, birthdate, gender, bio } = req.body;

    // Validate required fields
    if (!email || !password || !name || !birthdate || !gender) {
      res.status(400).json({ error: 'Missing required fields' });
      return;
    }

    // Validate age (must be 18+)
    const birth = new Date(birthdate);
    const today = new Date();
    let age = today.getFullYear() - birth.getFullYear();
    const monthDiff = today.getMonth() - birth.getMonth();
    if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birth.getDate())) {
      age--;
    }
    if (age < 18) {
      res.status(400).json({ error: 'Must be 18 or older' });
      return;
    }

    // Check if email exists
    const existingUser = await userService.getUserByEmail(email);
    if (existingUser) {
      res.status(400).json({ error: 'Email already registered' });
      return;
    }

    // Hash password
    const password_hash = await bcrypt.hash(password, 10);

    // Create user
    const user = await userService.createUser({
      email,
      password_hash,
      name,
      birthdate: new Date(birthdate),
      gender,
      bio,
    });

    // Set session
    req.session.userId = user.id;

    res.status(201).json({
      id: user.id,
      email: user.email,
      name: user.name,
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Registration failed' });
  }
});

/**
 * POST /api/auth/login
 * Authenticates a user with email and password.
 * Updates last_active timestamp and creates session cookie.
 */
router.post('/login', async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      res.status(400).json({ error: 'Email and password required' });
      return;
    }

    const user = await userService.getUserByEmail(email);
    if (!user) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }

    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }

    // Update last active
    await userService.updateLastActive(user.id);

    // Set session
    req.session.userId = user.id;

    res.json({
      id: user.id,
      email: user.email,
      name: user.name,
      is_admin: user.is_admin,
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

/**
 * POST /api/auth/logout
 * Destroys the current session and clears the session cookie.
 */
router.post('/logout', (req: Request, res: Response) => {
  req.session.destroy((err) => {
    if (err) {
      res.status(500).json({ error: 'Logout failed' });
      return;
    }
    res.clearCookie('connect.sid');
    res.json({ message: 'Logged out' });
  });
});

/**
 * GET /api/auth/me
 * Returns the current authenticated user's profile.
 * Excludes sensitive data like password hash.
 * Requires authentication.
 */
router.get('/me', requireAuth, async (req: Request, res: Response) => {
  try {
    const profile = await userService.getUserProfile(req.session.userId!);
    if (!profile) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    // Don't expose password hash
    const { password_hash, ...safeProfile } = profile;
    res.json(safeProfile);
  } catch (error) {
    console.error('Get profile error:', error);
    res.status(500).json({ error: 'Failed to get profile' });
  }
});

export default router;
