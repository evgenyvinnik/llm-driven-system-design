import { query } from '../services/database.js';
import { CacheService } from '../services/cache.js';
import { UnauthorizedError, ForbiddenError, hashString } from '../utils/index.js';
import config from '../config/index.js';

const cache = new CacheService();

/**
 * Authentication middleware - verifies API key or session token
 */
export async function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  const apiKey = req.headers['x-api-key'];

  try {
    if (apiKey) {
      // API key authentication
      const user = await verifyApiKey(apiKey);
      req.user = user;
      req.authMethod = 'api-key';
    } else if (authHeader && authHeader.startsWith('Bearer ')) {
      // Bearer token authentication
      const token = authHeader.substring(7);
      const user = await verifyBearerToken(token);
      req.user = user;
      req.authMethod = 'bearer';
    } else {
      // Allow anonymous access with limited permissions
      req.user = null;
      req.authMethod = 'anonymous';
    }

    next();
  } catch (error) {
    if (error.isOperational) {
      return res.status(error.statusCode).json({ error: error.message });
    }
    console.error('Auth error:', error);
    res.status(500).json({ error: 'Authentication failed' });
  }
}

/**
 * Require authentication middleware
 */
export function requireAuth(req, res, next) {
  if (!req.user) {
    return res.status(401).json({
      error: 'Authentication required',
      message: 'Please provide a valid API key or bearer token',
    });
  }
  next();
}

/**
 * Require admin role middleware
 */
export function requireAdmin(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

/**
 * Verify API key and return user info
 */
async function verifyApiKey(apiKey) {
  const keyHash = await hashString(apiKey);
  const cacheKey = `auth:apikey:${keyHash}`;

  // Check cache first
  const cached = await cache.get(cacheKey);
  if (cached) {
    return cached;
  }

  // Query database
  const result = await query(
    `SELECT ak.id, ak.user_id, ak.tier, ak.scopes, u.email, u.role
     FROM api_keys ak
     JOIN users u ON u.id = ak.user_id
     WHERE ak.key_hash = $1
       AND ak.revoked_at IS NULL
       AND (ak.expires_at IS NULL OR ak.expires_at > NOW())`,
    [keyHash]
  );

  if (result.rows.length === 0) {
    throw new UnauthorizedError('Invalid API key');
  }

  const user = {
    id: result.rows[0].user_id,
    email: result.rows[0].email,
    role: result.rows[0].role,
    tier: result.rows[0].tier,
    scopes: result.rows[0].scopes || [],
    apiKeyId: result.rows[0].id,
  };

  // Update last used timestamp (fire and forget)
  query('UPDATE api_keys SET last_used = NOW() WHERE id = $1', [user.apiKeyId]).catch(() => {});

  // Cache for 5 minutes
  await cache.set(cacheKey, user, 300);

  return user;
}

/**
 * Verify bearer token (simple session-based auth)
 */
async function verifyBearerToken(token) {
  const cacheKey = `auth:session:${token}`;

  // Check cache (session store)
  const cached = await cache.get(cacheKey);
  if (cached) {
    return cached;
  }

  // For development/demo: check admin token
  if (token === 'admin-token-dev') {
    return {
      id: 'admin-1',
      email: config.admin.email,
      role: 'admin',
      tier: 'enterprise',
      scopes: ['*'],
    };
  }

  throw new UnauthorizedError('Invalid or expired token');
}

/**
 * Login endpoint handler
 */
export async function login(req, res) {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password required' });
  }

  // Check admin credentials (for demo)
  if (email === config.admin.email && password === config.admin.password) {
    const token = 'admin-token-dev';
    const user = {
      id: 'admin-1',
      email: config.admin.email,
      role: 'admin',
      tier: 'enterprise',
      scopes: ['*'],
    };

    await cache.set(`auth:session:${token}`, user, 86400); // 24 hours

    return res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
      },
    });
  }

  // Query database for user
  try {
    const result = await query(
      `SELECT id, email, password_hash, role, tier
       FROM users
       WHERE email = $1`,
      [email]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = result.rows[0];

    // In production, use bcrypt.compare
    const passwordHash = await hashString(password);
    if (passwordHash !== user.password_hash) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Create session token
    const token = await hashString(`${user.id}:${Date.now()}:${Math.random()}`);
    const sessionUser = {
      id: user.id,
      email: user.email,
      role: user.role,
      tier: user.tier,
    };

    await cache.set(`auth:session:${token}`, sessionUser, 86400);

    res.json({
      token,
      user: sessionUser,
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
}

/**
 * Logout endpoint handler
 */
export async function logout(req, res) {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7);
    await cache.delete(`auth:session:${token}`);
  }
  res.json({ message: 'Logged out successfully' });
}
