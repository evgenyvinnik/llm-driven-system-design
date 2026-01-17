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

// Register a new user
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

// Login
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

// Logout
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

// Get current user
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

// Get user preferences
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

// Update user preferences
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

// Record article read
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

// Get reading history
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

// Get available topics for preferences
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
