import { Router } from 'express';
import authService from '../services/authService.js';
import { rateLimiters } from '../shared/rateLimit.js';
import { auditLog, AuditActions } from '../shared/audit.js';
import { authEventsTotal } from '../shared/metrics.js';

const router = Router();

// Apply auth rate limiting to sensitive endpoints
router.use('/register', rateLimiters.auth);
router.use('/login', rateLimiters.auth);

// Register
router.post('/register', async (req, res) => {
  try {
    const { email, password, username, displayName } = req.body;

    if (!email || !password || !username) {
      return res.status(400).json({ error: 'Email, password, and username are required' });
    }

    const user = await authService.register({ email, password, username, displayName });

    // Set session
    req.session.userId = user.id;

    // Audit log
    await auditLog(req, AuditActions.USER_REGISTER, 'user', user.id, { email, username });

    // Metrics
    authEventsTotal.inc({ event: 'register', success: 'true' });

    res.status(201).json({ user });
  } catch (error) {
    const log = req.log || console;
    log.error({ error: error.message }, 'Register error');
    authEventsTotal.inc({ event: 'register', success: 'false' });
    res.status(400).json({ error: error.message });
  }
});

// Login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const user = await authService.login({ email, password });

    // Set session
    req.session.userId = user.id;

    // Audit log
    await auditLog(req, AuditActions.USER_LOGIN, 'user', user.id, { email });

    // Metrics
    authEventsTotal.inc({ event: 'login', success: 'true' });

    res.json({ user });
  } catch (error) {
    const log = req.log || console;
    log.warn({ error: error.message, email: req.body.email }, 'Login failed');

    // Audit failed login attempt
    await auditLog(
      req,
      AuditActions.USER_LOGIN_FAILED,
      'user',
      null,
      { email: req.body.email, reason: error.message },
      false
    );

    authEventsTotal.inc({ event: 'login', success: 'false' });
    res.status(401).json({ error: error.message });
  }
});

// Logout
router.post('/logout', async (req, res) => {
  const userId = req.session?.userId;

  req.session.destroy((err) => {
    if (err) {
      return res.status(500).json({ error: 'Failed to logout' });
    }

    // Audit log (async, don't wait)
    if (userId) {
      auditLog(
        { ...req, session: { userId } },
        AuditActions.USER_LOGOUT,
        'user',
        userId,
        {}
      ).catch(() => {});
    }

    authEventsTotal.inc({ event: 'logout', success: 'true' });

    res.clearCookie('connect.sid');
    res.json({ success: true });
  });
});

// Get current user
router.get('/me', async (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    const user = await authService.getUserById(req.session.userId);
    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }
    res.json({ user });
  } catch (error) {
    const log = req.log || console;
    log.error({ error: error.message }, 'Get user error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update profile
router.patch('/me', async (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    const previousUser = await authService.getUserById(req.session.userId);
    const user = await authService.updateProfile(req.session.userId, req.body);

    // Audit log profile changes
    await auditLog(
      req,
      AuditActions.USER_UPDATE_PROFILE,
      'user',
      req.session.userId,
      {
        fields: Object.keys(req.body),
        previousDisplayName: previousUser.display_name,
        newDisplayName: user.display_name,
      }
    );

    res.json({ user });
  } catch (error) {
    const log = req.log || console;
    log.error({ error: error.message }, 'Update profile error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
