import { Request, Response, NextFunction } from 'express';
import { query } from '../utils/db.js';
import { getSession, getSigningSession } from '../utils/redis.js';
import { AuthUser } from '../types/express.js';

// Authenticate logged-in users
export async function authenticate(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const token = req.cookies.token || req.headers.authorization?.replace('Bearer ', '');

    if (!token) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const userId = await getSession(token);
    if (!userId) {
      res.status(401).json({ error: 'Invalid or expired session' });
      return;
    }

    const result = await query<AuthUser>('SELECT id, email, name, role FROM users WHERE id = $1', [userId]);
    if (result.rows.length === 0) {
      res.status(401).json({ error: 'User not found' });
      return;
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
export async function authenticateAdmin(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    await authenticate(req, res, () => {
      if (!req.user || req.user.role !== 'admin') {
        res.status(403).json({ error: 'Admin access required' });
        return;
      }
      next();
    });
  } catch (error) {
    console.error('Admin auth error:', error);
    res.status(500).json({ error: 'Authentication failed' });
  }
}

// Authenticate signing recipients via access token
export async function authenticateSigner(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const accessToken = req.params.accessToken || req.query.accessToken || req.body.accessToken;

    if (!accessToken) {
      res.status(401).json({ error: 'Signing access token required' });
      return;
    }

    // Check signing session in Redis first
    let signingData = await getSigningSession(accessToken as string);

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
        res.status(401).json({ error: 'Invalid signing link' });
        return;
      }

      signingData = result.rows[0];
    }

    // Check envelope status
    if (!['sent', 'delivered'].includes(signingData.envelope_status)) {
      res.status(400).json({
        error: 'This envelope is no longer available for signing',
        status: signingData.envelope_status
      });
      return;
    }

    // Check recipient status
    if (signingData.status === 'completed') {
      res.status(400).json({ error: 'You have already signed this document' });
      return;
    }

    if (signingData.status === 'declined') {
      res.status(400).json({ error: 'This signing request was declined' });
      return;
    }

    req.signer = signingData;
    req.accessToken = accessToken as string;
    next();
  } catch (error) {
    console.error('Signer auth error:', error);
    res.status(500).json({ error: 'Authentication failed' });
  }
}

// Optional authentication - proceeds even if not authenticated
export async function optionalAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const token = req.cookies.token || req.headers.authorization?.replace('Bearer ', '');

    if (token) {
      const userId = await getSession(token);
      if (userId) {
        const result = await query<AuthUser>('SELECT id, email, name, role FROM users WHERE id = $1', [userId]);
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
