import { v4 as uuidv4 } from 'uuid';
import { sessionGet, sessionSet, sessionDelete } from '../utils/redis.js';
import { query } from '../utils/db.js';
import logger, { logEvent } from '../shared/logger.js';

/**
 * Role-Based Access Control (RBAC) Configuration
 *
 * Roles:
 * - viewer: Can view public videos, search, watch history
 * - creator: All viewer permissions + upload, manage own channel/videos
 * - admin: All permissions + moderate content, manage users
 *
 * Role hierarchy: admin > creator > viewer
 */

export const ROLES = {
  VIEWER: 'viewer',
  CREATOR: 'creator',
  ADMIN: 'admin',
};

// Role hierarchy for permission checks
const ROLE_HIERARCHY = {
  [ROLES.VIEWER]: 1,
  [ROLES.CREATOR]: 2,
  [ROLES.ADMIN]: 3,
};

// Permission definitions
export const PERMISSIONS = {
  // Video permissions
  VIDEO_VIEW: 'video:view',
  VIDEO_UPLOAD: 'video:upload',
  VIDEO_EDIT_OWN: 'video:edit:own',
  VIDEO_DELETE_OWN: 'video:delete:own',
  VIDEO_MODERATE: 'video:moderate',

  // Channel permissions
  CHANNEL_VIEW: 'channel:view',
  CHANNEL_EDIT_OWN: 'channel:edit:own',
  CHANNEL_MODERATE: 'channel:moderate',

  // Comment permissions
  COMMENT_CREATE: 'comment:create',
  COMMENT_DELETE_OWN: 'comment:delete:own',
  COMMENT_MODERATE: 'comment:moderate',

  // User permissions
  USER_SUBSCRIBE: 'user:subscribe',
  USER_MANAGE: 'user:manage',

  // Admin permissions
  ADMIN_DASHBOARD: 'admin:dashboard',
  ADMIN_TRANSCODE: 'admin:transcode',
};

// Role to permissions mapping
const ROLE_PERMISSIONS = {
  [ROLES.VIEWER]: [
    PERMISSIONS.VIDEO_VIEW,
    PERMISSIONS.CHANNEL_VIEW,
    PERMISSIONS.COMMENT_CREATE,
    PERMISSIONS.COMMENT_DELETE_OWN,
    PERMISSIONS.USER_SUBSCRIBE,
  ],
  [ROLES.CREATOR]: [
    // Inherits viewer permissions
    ...ROLE_PERMISSIONS?.[ROLES.VIEWER] || [],
    PERMISSIONS.VIDEO_UPLOAD,
    PERMISSIONS.VIDEO_EDIT_OWN,
    PERMISSIONS.VIDEO_DELETE_OWN,
    PERMISSIONS.CHANNEL_EDIT_OWN,
  ],
  [ROLES.ADMIN]: [
    // All permissions
    ...Object.values(PERMISSIONS),
  ],
};

// Fix circular reference for creator permissions
ROLE_PERMISSIONS[ROLES.CREATOR] = [
  PERMISSIONS.VIDEO_VIEW,
  PERMISSIONS.CHANNEL_VIEW,
  PERMISSIONS.COMMENT_CREATE,
  PERMISSIONS.COMMENT_DELETE_OWN,
  PERMISSIONS.USER_SUBSCRIBE,
  PERMISSIONS.VIDEO_UPLOAD,
  PERMISSIONS.VIDEO_EDIT_OWN,
  PERMISSIONS.VIDEO_DELETE_OWN,
  PERMISSIONS.CHANNEL_EDIT_OWN,
];

/**
 * Check if a role has a specific permission
 */
export function hasPermission(role, permission) {
  const permissions = ROLE_PERMISSIONS[role] || [];
  return permissions.includes(permission);
}

/**
 * Check if role1 is at least as high as role2 in hierarchy
 */
export function isRoleAtLeast(userRole, requiredRole) {
  const userLevel = ROLE_HIERARCHY[userRole] || 0;
  const requiredLevel = ROLE_HIERARCHY[requiredRole] || 0;
  return userLevel >= requiredLevel;
}

// ============ Auth Middleware ============

/**
 * Authentication middleware - checks for valid session
 */
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

    // Log user context for request logging
    if (req.log) {
      req.log = req.log.child({ userId: session.id, username: session.username });
    }

    next();
  } catch (error) {
    (req.log || logger).error({ error: error.message }, 'Auth middleware error');
    res.status(500).json({ error: 'Authentication error' });
  }
};

/**
 * Optional auth - attaches user if logged in, but doesn't require it
 */
export const optionalAuth = async (req, res, next) => {
  try {
    const sessionId = req.cookies?.sessionId;

    if (sessionId) {
      const session = await sessionGet(sessionId);
      if (session) {
        req.user = session;
        req.sessionId = sessionId;

        // Log user context
        if (req.log) {
          req.log = req.log.child({ userId: session.id, username: session.username });
        }
      }
    }

    next();
  } catch (error) {
    // Continue without auth on error
    next();
  }
};

// ============ RBAC Middleware ============

/**
 * Require specific role(s)
 *
 * @param {string|string[]} roles - Required role(s)
 * @returns {Function} Express middleware
 *
 * @example
 * router.post('/videos', authenticate, requireRole('creator'), createVideo);
 * router.delete('/admin/users/:id', authenticate, requireRole(['admin']), deleteUser);
 */
export const requireRole = (roles) => {
  const allowedRoles = Array.isArray(roles) ? roles : [roles];

  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const userRole = req.user.role || ROLES.VIEWER;

    // Check if user's role is in the allowed list
    if (!allowedRoles.includes(userRole)) {
      // Also check role hierarchy - admin can do anything
      const hasHigherRole = allowedRoles.some((role) => isRoleAtLeast(userRole, role));

      if (!hasHigherRole) {
        (req.log || logger).warn({
          event: 'authorization_denied',
          userRole,
          requiredRoles: allowedRoles,
        }, 'Access denied: insufficient role');

        return res.status(403).json({
          error: 'Access denied',
          message: `Required role: ${allowedRoles.join(' or ')}`,
        });
      }
    }

    next();
  };
};

/**
 * Require specific permission
 *
 * @param {string} permission - Required permission
 * @returns {Function} Express middleware
 */
export const requirePermission = (permission) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const userRole = req.user.role || ROLES.VIEWER;

    if (!hasPermission(userRole, permission)) {
      (req.log || logger).warn({
        event: 'authorization_denied',
        userRole,
        requiredPermission: permission,
      }, 'Access denied: insufficient permission');

      return res.status(403).json({
        error: 'Access denied',
        message: `Required permission: ${permission}`,
      });
    }

    next();
  };
};

/**
 * Admin-only middleware (shorthand for requireRole('admin'))
 */
export const requireAdmin = requireRole(ROLES.ADMIN);

/**
 * Creator or admin middleware
 */
export const requireCreator = requireRole([ROLES.CREATOR, ROLES.ADMIN]);

/**
 * Check resource ownership
 *
 * @param {string} resourceType - Type of resource ('video', 'comment', 'channel')
 * @returns {Function} Express middleware
 */
export const requireOwnership = (resourceType) => {
  return async (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    // Admins bypass ownership check
    if (req.user.role === ROLES.ADMIN) {
      return next();
    }

    const resourceId = req.params.videoId || req.params.channelId || req.params.commentId || req.params.id;

    if (!resourceId) {
      return res.status(400).json({ error: 'Resource ID required' });
    }

    try {
      let isOwner = false;

      switch (resourceType) {
        case 'video': {
          const result = await query(
            'SELECT channel_id FROM videos WHERE id = $1',
            [resourceId]
          );
          if (result.rows.length > 0) {
            isOwner = result.rows[0].channel_id === req.user.id;
          }
          break;
        }

        case 'comment': {
          const result = await query(
            'SELECT user_id FROM comments WHERE id = $1',
            [resourceId]
          );
          if (result.rows.length > 0) {
            isOwner = result.rows[0].user_id === req.user.id;
          }
          break;
        }

        case 'channel': {
          const result = await query(
            'SELECT id FROM channels WHERE id = $1 AND user_id = $2',
            [resourceId, req.user.id]
          );
          isOwner = result.rows.length > 0;
          break;
        }

        default:
          return res.status(400).json({ error: 'Invalid resource type' });
      }

      if (!isOwner) {
        (req.log || logger).warn({
          event: 'ownership_denied',
          resourceType,
          resourceId,
          userId: req.user.id,
        }, 'Access denied: not resource owner');

        return res.status(403).json({
          error: 'Access denied',
          message: 'You do not own this resource',
        });
      }

      next();
    } catch (error) {
      (req.log || logger).error({ error: error.message }, 'Ownership check error');
      res.status(500).json({ error: 'Authorization error' });
    }
  };
};

// ============ Session Management ============

/**
 * Create session for user
 */
export const createSession = async (user) => {
  const sessionId = uuidv4();
  const sessionData = {
    id: user.id,
    username: user.username,
    email: user.email,
    channelName: user.channel_name,
    role: user.role || ROLES.VIEWER,
    avatarUrl: user.avatar_url,
    createdAt: new Date().toISOString(),
  };

  await sessionSet(sessionId, sessionData);
  return sessionId;
};

/**
 * Destroy session
 */
export const destroySession = async (sessionId) => {
  await sessionDelete(sessionId);
};

// ============ Auth Handlers ============

/**
 * Login handler
 */
export const login = async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

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

    const sessionId = await createSession(user);

    res.cookie('sessionId', sessionId, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    });

    logEvent.userLoggedIn(req.log || logger, {
      userId: user.id,
      username: user.username,
    });

    res.json({
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        channelName: user.channel_name,
        role: user.role || ROLES.VIEWER,
        avatarUrl: user.avatar_url,
      },
    });
  } catch (error) {
    (req.log || logger).error({ error: error.message }, 'Login error');
    res.status(500).json({ error: 'Login failed' });
  }
};

/**
 * Register handler
 */
export const register = async (req, res) => {
  try {
    const { username, email, password, channelName, role } = req.body;

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

    // Determine role - default to viewer, allow creator, block admin
    let userRole = ROLES.VIEWER;
    if (role === ROLES.CREATOR) {
      userRole = ROLES.CREATOR;
    }
    // Admin role cannot be self-assigned during registration

    // Create user (in production, hash the password with bcrypt)
    const result = await query(
      `INSERT INTO users (username, email, password_hash, channel_name, role)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [username, email, 'demo_hash', channelName || username, userRole]
    );

    const user = result.rows[0];
    const sessionId = await createSession(user);

    res.cookie('sessionId', sessionId, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    logEvent.userRegistered(req.log || logger, {
      userId: user.id,
      username: user.username,
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
    (req.log || logger).error({ error: error.message }, 'Register error');
    res.status(500).json({ error: 'Registration failed' });
  }
};

/**
 * Logout handler
 */
export const logout = async (req, res) => {
  try {
    const sessionId = req.cookies?.sessionId;

    if (sessionId) {
      await destroySession(sessionId);
    }

    res.clearCookie('sessionId');
    res.json({ message: 'Logged out successfully' });
  } catch (error) {
    (req.log || logger).error({ error: error.message }, 'Logout error');
    res.status(500).json({ error: 'Logout failed' });
  }
};

/**
 * Get current user
 */
export const getCurrentUser = async (req, res) => {
  res.json({ user: req.user });
};

/**
 * Update user role (admin only)
 */
export const updateUserRole = async (req, res) => {
  try {
    const { userId } = req.params;
    const { role } = req.body;

    if (!Object.values(ROLES).includes(role)) {
      return res.status(400).json({ error: 'Invalid role' });
    }

    const result = await query(
      'UPDATE users SET role = $1 WHERE id = $2 RETURNING id, username, email, role',
      [role, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    (req.log || logger).info({
      event: 'user_role_updated',
      targetUserId: userId,
      newRole: role,
      adminId: req.user.id,
    }, `User role updated to ${role}`);

    res.json({ user: result.rows[0] });
  } catch (error) {
    (req.log || logger).error({ error: error.message }, 'Update role error');
    res.status(500).json({ error: 'Failed to update role' });
  }
};
