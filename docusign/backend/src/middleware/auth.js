import { query } from '../utils/db.js';
import { getSession, getSigningSession } from '../utils/redis.js';

// Authenticate logged-in users
export async function authenticate(req, res, next) {
  try {
    const token = req.cookies.token || req.headers.authorization?.replace('Bearer ', '');

    if (!token) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const userId = await getSession(token);
    if (!userId) {
      return res.status(401).json({ error: 'Invalid or expired session' });
    }

    const result = await query('SELECT id, email, name, role FROM users WHERE id = $1', [userId]);
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'User not found' });
    }

    req.user = result.rows[0];
    req.token = token;
    next();
  } catch (error) {
    console.error('Auth error:', error);
    res.status(500).json({ error: 'Authentication failed' });
  }
}

// Authenticate admin users
export async function authenticateAdmin(req, res, next) {
  try {
    await authenticate(req, res, () => {
      if (req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Admin access required' });
      }
      next();
    });
  } catch (error) {
    console.error('Admin auth error:', error);
    res.status(500).json({ error: 'Authentication failed' });
  }
}

// Authenticate signing recipients via access token
export async function authenticateSigner(req, res, next) {
  try {
    const accessToken = req.params.accessToken || req.query.accessToken || req.body.accessToken;

    if (!accessToken) {
      return res.status(401).json({ error: 'Signing access token required' });
    }

    // Check signing session in Redis first
    let signingData = await getSigningSession(accessToken);

    if (!signingData) {
      // Fall back to database lookup
      const result = await query(
        `SELECT r.*, e.status as envelope_status, e.name as envelope_name
         FROM recipients r
         JOIN envelopes e ON r.envelope_id = e.id
         WHERE r.access_token = $1`,
        [accessToken]
      );

      if (result.rows.length === 0) {
        return res.status(401).json({ error: 'Invalid signing link' });
      }

      signingData = result.rows[0];
    }

    // Check envelope status
    if (!['sent', 'delivered'].includes(signingData.envelope_status)) {
      return res.status(400).json({
        error: 'This envelope is no longer available for signing',
        status: signingData.envelope_status
      });
    }

    // Check recipient status
    if (signingData.status === 'completed') {
      return res.status(400).json({ error: 'You have already signed this document' });
    }

    if (signingData.status === 'declined') {
      return res.status(400).json({ error: 'This signing request was declined' });
    }

    req.signer = signingData;
    req.accessToken = accessToken;
    next();
  } catch (error) {
    console.error('Signer auth error:', error);
    res.status(500).json({ error: 'Authentication failed' });
  }
}

// Optional authentication - proceeds even if not authenticated
export async function optionalAuth(req, res, next) {
  try {
    const token = req.cookies.token || req.headers.authorization?.replace('Bearer ', '');

    if (token) {
      const userId = await getSession(token);
      if (userId) {
        const result = await query('SELECT id, email, name, role FROM users WHERE id = $1', [userId]);
        if (result.rows.length > 0) {
          req.user = result.rows[0];
          req.token = token;
        }
      }
    }
    next();
  } catch (error) {
    // Proceed without authentication
    next();
  }
}
