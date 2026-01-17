import bcrypt from 'bcrypt';
import { query } from '../db/index.js';
import redisClient from '../db/redis.js';
import { v4 as uuidv4 } from 'uuid';

const SESSION_TTL = 60 * 60 * 24 * 7; // 7 days

// Auth middleware
export async function authMiddleware(req, res, next) {
  const sessionId = req.headers['x-session-id'] || req.cookies?.sessionId;

  if (!sessionId) {
    req.user = null;
    return next();
  }

  try {
    const sessionData = await redisClient.get(`session:${sessionId}`);
    if (sessionData) {
      req.user = JSON.parse(sessionData);
      req.sessionId = sessionId;
    } else {
      req.user = null;
    }
  } catch (err) {
    console.error('Session lookup error:', err);
    req.user = null;
  }

  next();
}

// Require authentication middleware
export function requireAuth(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  next();
}

// Require admin middleware
export function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

// Login handler
export async function login(req, res) {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  try {
    const result = await query(
      'SELECT id, username, email, password_hash, display_name, role, avatar_url FROM users WHERE username = $1 OR email = $1',
      [username]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = result.rows[0];
    const validPassword = await bcrypt.compare(password, user.password_hash);

    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Create session
    const sessionId = uuidv4();
    const sessionData = {
      id: user.id,
      username: user.username,
      email: user.email,
      display_name: user.display_name,
      role: user.role,
      avatar_url: user.avatar_url,
    };

    await redisClient.setEx(`session:${sessionId}`, SESSION_TTL, JSON.stringify(sessionData));

    res.json({
      sessionId,
      user: sessionData,
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
}

// Register handler
export async function register(req, res) {
  const { username, email, password, displayName } = req.body;

  if (!username || !email || !password) {
    return res.status(400).json({ error: 'Username, email, and password required' });
  }

  try {
    // Check if user exists
    const existing = await query(
      'SELECT id FROM users WHERE username = $1 OR email = $2',
      [username, email]
    );

    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'Username or email already exists' });
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, 10);

    // Create user
    const result = await query(
      `INSERT INTO users (username, email, password_hash, display_name)
       VALUES ($1, $2, $3, $4)
       RETURNING id, username, email, display_name, role, avatar_url`,
      [username, email, passwordHash, displayName || username]
    );

    const user = result.rows[0];

    // Create session
    const sessionId = uuidv4();
    const sessionData = {
      id: user.id,
      username: user.username,
      email: user.email,
      display_name: user.display_name,
      role: user.role,
      avatar_url: user.avatar_url,
    };

    await redisClient.setEx(`session:${sessionId}`, SESSION_TTL, JSON.stringify(sessionData));

    res.status(201).json({
      sessionId,
      user: sessionData,
    });
  } catch (err) {
    console.error('Registration error:', err);
    res.status(500).json({ error: 'Registration failed' });
  }
}

// Logout handler
export async function logout(req, res) {
  const sessionId = req.headers['x-session-id'] || req.sessionId;

  if (sessionId) {
    await redisClient.del(`session:${sessionId}`);
  }

  res.json({ success: true });
}

// Get current user
export async function getCurrentUser(req, res) {
  if (!req.user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  res.json({ user: req.user });
}
