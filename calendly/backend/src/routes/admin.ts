import { Router, Request, Response } from 'express';
import { userService } from '../services/userService.js';
import { meetingTypeService } from '../services/meetingTypeService.js';
import { bookingService } from '../services/bookingService.js';
import { emailService } from '../services/emailService.js';
import { pool } from '../db/index.js';
import { requireAdmin } from '../middleware/auth.js';

const router = Router();

// All admin routes require admin authentication
router.use(requireAdmin);

/**
 * GET /api/admin/stats - Get system-wide statistics
 */
router.get('/stats', async (req: Request, res: Response) => {
  try {
    const [usersResult, meetingTypesResult, bookingsResult, emailsResult] = await Promise.all([
      pool.query(`SELECT COUNT(*) as count FROM users`),
      pool.query(`SELECT COUNT(*) as count FROM meeting_types`),
      pool.query(`
        SELECT
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE status = 'confirmed') as confirmed,
          COUNT(*) FILTER (WHERE status = 'cancelled') as cancelled,
          COUNT(*) FILTER (WHERE start_time > NOW() AND status = 'confirmed') as upcoming
        FROM bookings
      `),
      pool.query(`SELECT COUNT(*) as count FROM email_notifications`),
    ]);

    res.json({
      success: true,
      data: {
        users: parseInt(usersResult.rows[0].count),
        meeting_types: parseInt(meetingTypesResult.rows[0].count),
        bookings: {
          total: parseInt(bookingsResult.rows[0].total),
          confirmed: parseInt(bookingsResult.rows[0].confirmed),
          cancelled: parseInt(bookingsResult.rows[0].cancelled),
          upcoming: parseInt(bookingsResult.rows[0].upcoming),
        },
        emails_sent: parseInt(emailsResult.rows[0].count),
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to get statistics',
    });
  }
});

/**
 * GET /api/admin/users - Get all users
 */
router.get('/users', async (req: Request, res: Response) => {
  try {
    const users = await userService.getAllUsers();

    res.json({
      success: true,
      data: users,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to get users',
    });
  }
});

/**
 * GET /api/admin/bookings - Get all bookings with filters
 */
router.get('/bookings', async (req: Request, res: Response) => {
  try {
    const limit = parseInt((req.query.limit as string) || '100');
    const status = req.query.status as string | undefined;

    let query = `
      SELECT b.*,
             mt.name as meeting_type_name,
             u.name as host_name,
             u.email as host_email
      FROM bookings b
      JOIN meeting_types mt ON b.meeting_type_id = mt.id
      JOIN users u ON b.host_user_id = u.id
    `;

    const params: (string | number)[] = [];

    if (status) {
      query += ` WHERE b.status = $1`;
      params.push(status);
    }

    query += ` ORDER BY b.created_at DESC LIMIT $${params.length + 1}`;
    params.push(limit);

    const result = await pool.query(query, params);

    res.json({
      success: true,
      data: result.rows,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to get bookings',
    });
  }
});

/**
 * GET /api/admin/emails - Get email notification logs
 */
router.get('/emails', async (req: Request, res: Response) => {
  try {
    const limit = parseInt((req.query.limit as string) || '100');
    const emails = await emailService.getAllEmails(limit);

    res.json({
      success: true,
      data: emails,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to get email logs',
    });
  }
});

/**
 * DELETE /api/admin/users/:id - Delete a user (admin only)
 */
router.delete('/users/:id', async (req: Request, res: Response) => {
  try {
    // Prevent deleting self
    if (req.params.id === req.session.userId) {
      res.status(400).json({
        success: false,
        error: 'Cannot delete your own account',
      });
      return;
    }

    const deleted = await userService.deleteUser(req.params.id);

    if (!deleted) {
      res.status(404).json({
        success: false,
        error: 'User not found',
      });
      return;
    }

    res.json({
      success: true,
      message: 'User deleted',
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to delete user',
    });
  }
});

/**
 * GET /api/admin/bookings/recent - Get recent booking activity
 */
router.get('/bookings/recent', async (req: Request, res: Response) => {
  try {
    const result = await pool.query(`
      SELECT
        DATE(created_at) as date,
        COUNT(*) as bookings,
        COUNT(*) FILTER (WHERE status = 'cancelled') as cancellations
      FROM bookings
      WHERE created_at >= NOW() - INTERVAL '30 days'
      GROUP BY DATE(created_at)
      ORDER BY date DESC
    `);

    res.json({
      success: true,
      data: result.rows,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to get recent bookings',
    });
  }
});

export default router;
