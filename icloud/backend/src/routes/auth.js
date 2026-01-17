import { Router } from 'express';
import bcrypt from 'bcrypt';
import { v4 as uuidv4 } from 'uuid';
import { pool, redis } from '../db.js';

const router = Router();

// Register new user
router.post('/register', async (req, res) => {
  try {
    const { email, password, deviceName, deviceType } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    // Check if user exists
    const existing = await pool.query(
      'SELECT id FROM users WHERE email = $1',
      [email]
    );

    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'Email already registered' });
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, 10);

    // Create user
    const userResult = await pool.query(
      `INSERT INTO users (email, password_hash)
       VALUES ($1, $2)
       RETURNING id, email, role, storage_quota, storage_used`,
      [email, passwordHash]
    );

    const user = userResult.rows[0];

    // Create device if provided
    let deviceId = null;
    if (deviceName) {
      const deviceResult = await pool.query(
        `INSERT INTO devices (user_id, name, device_type)
         VALUES ($1, $2, $3)
         RETURNING id`,
        [user.id, deviceName, deviceType || 'web']
      );
      deviceId = deviceResult.rows[0].id;
    }

    // Create root folder for user
    await pool.query(
      `INSERT INTO files (user_id, name, path, is_folder, version_vector)
       VALUES ($1, $2, $3, TRUE, $4)`,
      [user.id, 'iCloud Drive', '/', JSON.stringify({})]
    );

    // Create session
    const token = uuidv4();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

    await pool.query(
      `INSERT INTO sessions (user_id, device_id, token, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [user.id, deviceId, token, expiresAt]
    );

    res.cookie('session_token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      expires: expiresAt,
    });

    res.status(201).json({
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        storageQuota: user.storage_quota,
        storageUsed: user.storage_used,
      },
      deviceId,
      token,
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// Login
router.post('/login', async (req, res) => {
  try {
    const { email, password, deviceName, deviceType } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    // Find user
    const userResult = await pool.query(
      `SELECT id, email, password_hash, role, storage_quota, storage_used
       FROM users WHERE email = $1`,
      [email]
    );

    if (userResult.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = userResult.rows[0];

    // Verify password
    const passwordValid = await bcrypt.compare(password, user.password_hash);

    if (!passwordValid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Create or get device
    let deviceId = null;
    if (deviceName) {
      // Check if device exists
      const existingDevice = await pool.query(
        `SELECT id FROM devices WHERE user_id = $1 AND name = $2`,
        [user.id, deviceName]
      );

      if (existingDevice.rows.length > 0) {
        deviceId = existingDevice.rows[0].id;
      } else {
        const deviceResult = await pool.query(
          `INSERT INTO devices (user_id, name, device_type)
           VALUES ($1, $2, $3)
           RETURNING id`,
          [user.id, deviceName, deviceType || 'web']
        );
        deviceId = deviceResult.rows[0].id;
      }
    }

    // Create session
    const token = uuidv4();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

    await pool.query(
      `INSERT INTO sessions (user_id, device_id, token, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [user.id, deviceId, token, expiresAt]
    );

    res.cookie('session_token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      expires: expiresAt,
    });

    res.json({
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        storageQuota: user.storage_quota,
        storageUsed: user.storage_used,
      },
      deviceId,
      token,
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

// Logout
router.post('/logout', async (req, res) => {
  try {
    const token = req.cookies.session_token || req.headers.authorization?.replace('Bearer ', '');

    if (token) {
      await pool.query('DELETE FROM sessions WHERE token = $1', [token]);
      await redis.del(`session:${token}`);
    }

    res.clearCookie('session_token');
    res.json({ message: 'Logged out successfully' });
  } catch (error) {
    console.error('Logout error:', error);
    res.status(500).json({ error: 'Logout failed' });
  }
});

// Get current user
router.get('/me', async (req, res) => {
  try {
    const token = req.cookies.session_token || req.headers.authorization?.replace('Bearer ', '');

    if (!token) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const result = await pool.query(
      `SELECT u.id, u.email, u.role, u.storage_quota, u.storage_used, s.device_id
       FROM sessions s
       JOIN users u ON s.user_id = u.id
       WHERE s.token = $1 AND s.expires_at > NOW()`,
      [token]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid or expired session' });
    }

    const user = result.rows[0];

    res.json({
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        storageQuota: user.storage_quota,
        storageUsed: user.storage_used,
      },
      deviceId: user.device_id,
    });
  } catch (error) {
    console.error('Get current user error:', error);
    res.status(500).json({ error: 'Failed to get user' });
  }
});

export default router;
