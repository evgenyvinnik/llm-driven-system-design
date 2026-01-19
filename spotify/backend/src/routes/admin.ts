import { Router, Response } from 'express';
import { pool } from '../db.js';
import { requireAdmin, Roles, clearRoleCache } from '../middleware/auth.js';
import { rateLimiters } from '../shared/rateLimit.js';
import { auditLog, AuditActions, queryAuditLogs } from '../shared/audit.js';
import type { AuthenticatedRequest, User, PlatformStats } from '../types.js';

const router = Router();

interface AdminQuery {
  limit?: string;
  offset?: string;
  search?: string;
  actorId?: string;
  action?: string;
  resourceType?: string;
  resourceId?: string;
  startDate?: string;
  endDate?: string;
  success?: string;
}

interface RoleUpdateBody {
  role?: string;
}

interface BanBody {
  reason?: string;
}

// All admin routes require admin role and rate limiting
router.use(requireAdmin);
router.use(rateLimiters.admin);

// Get all users (paginated)
router.get('/users', async (req, res: Response): Promise<void> => {
  const authReq = req as AuthenticatedRequest;
  try {
    const { limit = '50', offset = '0', search = '' } = req.query as AdminQuery;

    let query = `
      SELECT id, email, username, display_name, avatar_url, is_premium, role, created_at, updated_at
      FROM users
    `;
    const params: unknown[] = [];
    let paramIndex = 1;

    if (search) {
      query += ` WHERE email ILIKE $${paramIndex} OR username ILIKE $${paramIndex}`;
      params.push(`%${search}%`);
      paramIndex++;
    }

    query += ` ORDER BY created_at DESC LIMIT $${paramIndex++} OFFSET $${paramIndex}`;
    params.push(parseInt(limit), parseInt(offset));

    const result = await pool.query(query, params);

    const countQuery = search
      ? 'SELECT COUNT(*) FROM users WHERE email ILIKE $1 OR username ILIKE $1'
      : 'SELECT COUNT(*) FROM users';
    const countParams = search ? [`%${search}%`] : [];
    const countResult = await pool.query(countQuery, countParams);

    res.json({
      users: result.rows as User[],
      total: parseInt(countResult.rows[0].count as string),
      limit: parseInt(limit),
      offset: parseInt(offset),
    });
  } catch (error) {
    const log = authReq.log || console;
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    log.error({ error: errorMessage }, 'Admin get users error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get user by ID
router.get('/users/:id', async (req, res: Response): Promise<void> => {
  const authReq = req as AuthenticatedRequest;
  try {
    const result = await pool.query(
      `SELECT id, email, username, display_name, avatar_url, is_premium, role, created_at, updated_at
       FROM users WHERE id = $1`,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    res.json(result.rows[0] as User);
  } catch (error) {
    const log = authReq.log || console;
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    log.error({ error: errorMessage }, 'Admin get user error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update user role
router.patch('/users/:id/role', async (req, res: Response): Promise<void> => {
  const authReq = req as AuthenticatedRequest;
  try {
    const { role } = req.body as RoleUpdateBody;
    const validRoles = Object.values(Roles);

    if (!role || !validRoles.includes(role as typeof Roles[keyof typeof Roles])) {
      res.status(400).json({
        error: 'Invalid role',
        validRoles,
      });
      return;
    }

    // Get current role for audit log
    const currentResult = await pool.query('SELECT role FROM users WHERE id = $1', [req.params.id]);
    if (currentResult.rows.length === 0) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    const previousRole = currentResult.rows[0].role as string;

    // Update role
    const result = await pool.query(
      `UPDATE users SET role = $1, updated_at = NOW()
       WHERE id = $2
       RETURNING id, email, username, role`,
      [role, req.params.id]
    );

    // Clear role cache
    clearRoleCache(req.params.id);

    // Audit log
    await auditLog(
      authReq,
      AuditActions.ADMIN_ROLE_CHANGE,
      'user',
      req.params.id,
      { previousRole, newRole: role }
    );

    res.json(result.rows[0]);
  } catch (error) {
    const log = authReq.log || console;
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    log.error({ error: errorMessage }, 'Admin update role error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Ban user
router.post('/users/:id/ban', async (req, res: Response): Promise<void> => {
  const authReq = req as AuthenticatedRequest;
  try {
    const { reason } = req.body as BanBody;

    // Check user exists
    const userCheck = await pool.query('SELECT id, email FROM users WHERE id = $1', [req.params.id]);
    if (userCheck.rows.length === 0) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    // Update user to banned (using role field)
    await pool.query(
      `UPDATE users SET role = 'banned', updated_at = NOW() WHERE id = $1`,
      [req.params.id]
    );

    // Clear role cache
    clearRoleCache(req.params.id);

    // Audit log
    await auditLog(
      authReq,
      AuditActions.ADMIN_USER_BAN,
      'user',
      req.params.id,
      { reason, email: userCheck.rows[0].email as string }
    );

    res.json({ success: true, userId: req.params.id });
  } catch (error) {
    const log = authReq.log || console;
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    log.error({ error: errorMessage }, 'Admin ban user error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Unban user
router.post('/users/:id/unban', async (req, res: Response): Promise<void> => {
  const authReq = req as AuthenticatedRequest;
  try {
    // Check user exists
    const userCheck = await pool.query('SELECT id, email FROM users WHERE id = $1', [req.params.id]);
    if (userCheck.rows.length === 0) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    // Update user to regular user role
    await pool.query(
      `UPDATE users SET role = 'user', updated_at = NOW() WHERE id = $1`,
      [req.params.id]
    );

    // Clear role cache
    clearRoleCache(req.params.id);

    // Audit log
    await auditLog(
      authReq,
      AuditActions.ADMIN_USER_UNBAN,
      'user',
      req.params.id,
      { email: userCheck.rows[0].email as string }
    );

    res.json({ success: true, userId: req.params.id });
  } catch (error) {
    const log = authReq.log || console;
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    log.error({ error: errorMessage }, 'Admin unban user error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get audit logs
router.get('/audit-logs', async (req, res: Response): Promise<void> => {
  const authReq = req as AuthenticatedRequest;
  try {
    const {
      actorId,
      action,
      resourceType,
      resourceId,
      startDate,
      endDate,
      success,
      limit = '100',
      offset = '0',
    } = req.query as AdminQuery;

    const result = await queryAuditLogs({
      actorId: actorId || null,
      action: action || null,
      resourceType: resourceType || null,
      resourceId: resourceId || null,
      startDate: startDate ? new Date(startDate) : null,
      endDate: endDate ? new Date(endDate) : null,
      success: success !== undefined ? success === 'true' : null,
      limit: parseInt(limit),
      offset: parseInt(offset),
    });

    res.json(result);
  } catch (error) {
    const log = authReq.log || console;
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    log.error({ error: errorMessage }, 'Admin get audit logs error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Platform statistics
router.get('/stats', async (req, res: Response): Promise<void> => {
  const authReq = req as AuthenticatedRequest;
  try {
    const [users, tracks, playlists, streams] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM users'),
      pool.query('SELECT COUNT(*) FROM tracks'),
      pool.query('SELECT COUNT(*) FROM playlists'),
      pool.query('SELECT SUM(stream_count) FROM tracks'),
    ]);

    const stats: PlatformStats = {
      totalUsers: parseInt(users.rows[0].count as string),
      totalTracks: parseInt(tracks.rows[0].count as string),
      totalPlaylists: parseInt(playlists.rows[0].count as string),
      totalStreams: parseInt(streams.rows[0].sum as string) || 0,
    };

    res.json(stats);
  } catch (error) {
    const log = authReq.log || console;
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    log.error({ error: errorMessage }, 'Admin get stats error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
