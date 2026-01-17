/**
 * User API routes.
 * Provides endpoints for user authentication, preferences, and reading history.
 * Supports registration, login/logout, and profile management.
 * @module routes/user
 */

import { Router, Request, Response } from 'express';
import {
  createUser,
  authenticateUser,
  getUserById,
  getUserPreferences,
  updateUserPreferences,
  recordArticleRead,
  getReadingHistory,
  getAvailableTopics,
} from '../services/user.js';
import { v4 as uuid } from 'uuid';
import { sessionStore } from '../db/redis.js';

const router = Router();

/**
 * POST /register - Register a new user
 * Creates a user account and initializes an authenticated session.
 * Returns the user profile and sets a session cookie.
 */
router.post('/register', async (req: Request, res: Response) => {
  try {
    const { username, email, password } = req.body;

    if (!username || !email || !password) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    const user = await createUser(username, email, password);

    // Create session
    const sessionId = uuid();
    await sessionStore.set(sessionId, { userId: user.id, role: user.role });

    res.cookie('session_id', sessionId, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      maxAge: 86400000, // 24 hours
    });

    res.status(201).json({
      id: user.id,
      username: user.username,
      email: user.email,
      role: user.role,
    });
  } catch (error) {
    console.error('Error creating user:', error);
    if ((error as { code?: string }).code === '23505') {
      return res.status(409).json({ error: 'Username or email already exists' });
    }
    res.status(500).json({ error: 'Failed to create user' });
  }
});

/**
 * POST /login - Authenticate user
 * Validates credentials and creates an authenticated session.
 * Returns the user profile and sets a session cookie.
 */
router.post('/login', async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Missing email or password' });
    }

    const user = await authenticateUser(email, password);

    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Create session
    const sessionId = uuid();
    await sessionStore.set(sessionId, { userId: user.id, role: user.role });

    res.cookie('session_id', sessionId, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      maxAge: 86400000,
    });

    res.json({
      id: user.id,
      username: user.username,
      email: user.email,
      role: user.role,
    });
  } catch (error) {
    console.error('Error logging in:', error);
    res.status(500).json({ error: 'Failed to login' });
  }
});

/**
 * POST /logout - End user session
 * Destroys the session and clears the session cookie.
 */
router.post('/logout', async (req: Request, res: Response) => {
  try {
    const sessionId = req.cookies?.session_id;
    if (sessionId) {
      await sessionStore.destroy(sessionId);
    }
    res.clearCookie('session_id');
    res.json({ message: 'Logged out successfully' });
  } catch (error) {
    console.error('Error logging out:', error);
    res.status(500).json({ error: 'Failed to logout' });
  }
});

/**
 * GET /me - Get current user profile
 * Returns the authenticated user's profile information.
 * Requires authentication.
 */
router.get('/me', async (req: Request, res: Response) => {
  try {
    const session = req.session as { userId?: string } | undefined;
    if (!session?.userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const user = await getUserById(session.userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({
      id: user.id,
      username: user.username,
      email: user.email,
      role: user.role,
    });
  } catch (error) {
    console.error('Error getting user:', error);
    res.status(500).json({ error: 'Failed to get user' });
  }
});

/**
 * GET /preferences - Get user preferences
 * Returns the user's topic and source preferences.
 * Requires authentication.
 */
router.get('/preferences', async (req: Request, res: Response) => {
  try {
    const session = req.session as { userId?: string } | undefined;
    if (!session?.userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const preferences = await getUserPreferences(session.userId);
    res.json(preferences);
  } catch (error) {
    console.error('Error getting preferences:', error);
    res.status(500).json({ error: 'Failed to get preferences' });
  }
});

/**
 * PUT /preferences - Update user preferences
 * Updates the user's topic and source preferences.
 * Requires authentication.
 */
router.put('/preferences', async (req: Request, res: Response) => {
  try {
    const session = req.session as { userId?: string } | undefined;
    if (!session?.userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const { preferred_topics, preferred_sources, blocked_sources } = req.body;

    const preferences = await updateUserPreferences(session.userId, {
      preferred_topics,
      preferred_sources,
      blocked_sources,
    });

    res.json(preferences);
  } catch (error) {
    console.error('Error updating preferences:', error);
    res.status(500).json({ error: 'Failed to update preferences' });
  }
});

/**
 * POST /reading-history - Record article read
 * Records that the user read an article and updates topic weights.
 * Used for learning implicit preferences based on reading behavior.
 * Requires authentication.
 */
router.post('/reading-history', async (req: Request, res: Response) => {
  try {
    const session = req.session as { userId?: string } | undefined;
    if (!session?.userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const { article_id, dwell_time_seconds } = req.body;

    if (!article_id) {
      return res.status(400).json({ error: 'Missing article_id' });
    }

    await recordArticleRead(session.userId, article_id, dwell_time_seconds || 0);
    res.json({ message: 'Reading recorded' });
  } catch (error) {
    console.error('Error recording read:', error);
    res.status(500).json({ error: 'Failed to record reading' });
  }
});

/**
 * GET /reading-history - Get user's reading history
 * Returns recent articles the user has read.
 * Requires authentication.
 */
router.get('/reading-history', async (req: Request, res: Response) => {
  try {
    const session = req.session as { userId?: string } | undefined;
    if (!session?.userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const limit = parseInt(req.query.limit as string) || 50;
    const history = await getReadingHistory(session.userId, limit);
    res.json({ history });
  } catch (error) {
    console.error('Error getting reading history:', error);
    res.status(500).json({ error: 'Failed to get reading history' });
  }
});

/**
 * GET /available-topics - Get available topics for preferences
 * Returns all topics from recent stories for preference selection.
 */
router.get('/available-topics', async (_req: Request, res: Response) => {
  try {
    const topics = await getAvailableTopics();
    res.json({ topics });
  } catch (error) {
    console.error('Error getting available topics:', error);
    res.status(500).json({ error: 'Failed to get topics' });
  }
});

export default router;
