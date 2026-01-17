import { Router } from 'express';
import { verifyPassword, createUser, getUserById, updateUser, searchUsers, getAllUsers } from '../services/userService.js';
import { requireAuth } from '../middleware/auth.js';

/**
 * Authentication and user management routes.
 * Handles login/logout, registration, and user profile operations.
 */
const router = Router();

/**
 * POST /login
 * Authenticates a user with email and password, creates a session.
 */
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const user = await verifyPassword(email, password);
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    req.session.userId = user.id;
    res.json({ user });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

/**
 * POST /logout
 * Destroys the current session and clears the session cookie.
 */
router.post('/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      return res.status(500).json({ error: 'Logout failed' });
    }
    res.clearCookie('connect.sid');
    res.json({ message: 'Logged out' });
  });
});

/**
 * POST /register
 * Creates a new user account and automatically logs them in.
 */
router.post('/register', async (req, res) => {
  try {
    const { email, password, name } = req.body;

    if (!email || !password || !name) {
      return res.status(400).json({ error: 'Email, password, and name are required' });
    }

    const user = await createUser({ email, password, name });
    req.session.userId = user.id;
    res.status(201).json({ user });
  } catch (error: unknown) {
    if ((error as { code?: string }).code === '23505') {
      return res.status(409).json({ error: 'Email already exists' });
    }
    console.error('Register error:', error);
    res.status(500).json({ error: 'Registration failed' });
  }
});

/**
 * GET /me
 * Returns the currently authenticated user's profile.
 */
router.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

/**
 * PATCH /me
 * Updates the current user's profile (name, avatar_url).
 */
router.patch('/me', requireAuth, async (req, res) => {
  try {
    const { name, avatar_url } = req.body;
    const user = await updateUser(req.user!.id, { name, avatar_url });
    res.json({ user });
  } catch (error) {
    console.error('Update user error:', error);
    res.status(500).json({ error: 'Update failed' });
  }
});

/**
 * GET /search
 * Searches users by name or email for autocomplete.
 */
router.get('/search', requireAuth, async (req, res) => {
  try {
    const { q, limit } = req.query;
    const users = await searchUsers(
      String(q || ''),
      limit ? parseInt(String(limit), 10) : 10
    );
    res.json({ users });
  } catch (error) {
    console.error('Search users error:', error);
    res.status(500).json({ error: 'Search failed' });
  }
});

/**
 * GET /
 * Returns all users for dropdown menus.
 */
router.get('/', requireAuth, async (req, res) => {
  try {
    const users = await getAllUsers();
    res.json({ users });
  } catch (error) {
    console.error('Get users error:', error);
    res.status(500).json({ error: 'Failed to get users' });
  }
});

/**
 * GET /:id
 * Returns a specific user by ID.
 */
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const user = await getUserById(req.params.id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json({ user });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ error: 'Failed to get user' });
  }
});

export default router;
