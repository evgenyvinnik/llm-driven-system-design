import { v4 as uuidv4 } from 'uuid';
import { sessionGet, sessionSet, sessionDelete } from '../utils/redis.js';
import { query } from '../utils/db.js';

// Auth middleware - checks for valid session
export const authenticate = async (req, res, next) => {
  try {
    const sessionId = req.cookies?.sessionId;

    if (!sessionId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const session = await sessionGet(sessionId);

    if (!session) {
      res.clearCookie('sessionId');
      return res.status(401).json({ error: 'Session expired' });
    }

    // Attach user to request
    req.user = session;
    req.sessionId = sessionId;
    next();
  } catch (error) {
    console.error('Auth middleware error:', error);
    res.status(500).json({ error: 'Authentication error' });
  }
};

// Optional auth - attaches user if logged in, but doesn't require it
export const optionalAuth = async (req, res, next) => {
  try {
    const sessionId = req.cookies?.sessionId;

    if (sessionId) {
      const session = await sessionGet(sessionId);
      if (session) {
        req.user = session;
        req.sessionId = sessionId;
      }
    }

    next();
  } catch (error) {
    // Continue without auth on error
    next();
  }
};

// Admin-only middleware
export const requireAdmin = (req, res, next) => {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
};

// Create session
export const createSession = async (user) => {
  const sessionId = uuidv4();
  const sessionData = {
    id: user.id,
    username: user.username,
    email: user.email,
    channelName: user.channel_name,
    role: user.role,
    avatarUrl: user.avatar_url,
  };

  await sessionSet(sessionId, sessionData);
  return sessionId;
};

// Destroy session
export const destroySession = async (sessionId) => {
  await sessionDelete(sessionId);
};

// Login handler
export const login = async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    // For demo purposes, we use a simple password check
    // In production, use bcrypt
    const result = await query(
      'SELECT * FROM users WHERE username = $1',
      [username]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = result.rows[0];

    // Simple password verification (in production, use bcrypt.compare)
    // For demo, any password works for existing users
    // You can implement proper password hashing if needed

    const sessionId = await createSession(user);

    res.cookie('sessionId', sessionId, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    });

    res.json({
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        channelName: user.channel_name,
        role: user.role,
        avatarUrl: user.avatar_url,
      },
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
};

// Register handler
export const register = async (req, res) => {
  try {
    const { username, email, password, channelName } = req.body;

    if (!username || !email || !password) {
      return res.status(400).json({ error: 'Username, email, and password are required' });
    }

    // Check if user exists
    const existingUser = await query(
      'SELECT id FROM users WHERE username = $1 OR email = $2',
      [username, email]
    );

    if (existingUser.rows.length > 0) {
      return res.status(409).json({ error: 'Username or email already exists' });
    }

    // Create user (in production, hash the password with bcrypt)
    const result = await query(
      `INSERT INTO users (username, email, password_hash, channel_name)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [username, email, 'demo_hash', channelName || username]
    );

    const user = result.rows[0];
    const sessionId = await createSession(user);

    res.cookie('sessionId', sessionId, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    res.status(201).json({
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        channelName: user.channel_name,
        role: user.role,
        avatarUrl: user.avatar_url,
      },
    });
  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({ error: 'Registration failed' });
  }
};

// Logout handler
export const logout = async (req, res) => {
  try {
    const sessionId = req.cookies?.sessionId;

    if (sessionId) {
      await destroySession(sessionId);
    }

    res.clearCookie('sessionId');
    res.json({ message: 'Logged out successfully' });
  } catch (error) {
    console.error('Logout error:', error);
    res.status(500).json({ error: 'Logout failed' });
  }
};

// Get current user
export const getCurrentUser = async (req, res) => {
  res.json({ user: req.user });
};
