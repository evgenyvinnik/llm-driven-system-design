import { query } from '../db/pool.js';
import { hashApiKey } from '../utils/helpers.js';

/**
 * Authentication middleware - validates API key
 */
export async function authenticateApiKey(req, res, next) {
  // Get API key from Authorization header
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    return res.status(401).json({
      error: {
        type: 'authentication_error',
        message: 'No API key provided. Use Authorization: Bearer sk_test_xxx',
      },
    });
  }

  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer') {
    return res.status(401).json({
      error: {
        type: 'authentication_error',
        message: 'Invalid authorization format. Use Authorization: Bearer sk_test_xxx',
      },
    });
  }

  const apiKey = parts[1];

  // Validate API key format
  if (!apiKey.startsWith('sk_test_') && !apiKey.startsWith('sk_live_')) {
    return res.status(401).json({
      error: {
        type: 'authentication_error',
        message: 'Invalid API key format',
      },
    });
  }

  try {
    // Look up merchant by API key
    const result = await query(`
      SELECT id, name, email, status, webhook_url, webhook_secret
      FROM merchants
      WHERE api_key = $1 AND status = 'active'
    `, [apiKey]);

    if (result.rows.length === 0) {
      return res.status(401).json({
        error: {
          type: 'authentication_error',
          message: 'Invalid API key',
        },
      });
    }

    // Attach merchant to request
    req.merchant = result.rows[0];
    req.merchantId = result.rows[0].id;

    next();
  } catch (error) {
    console.error('Auth error:', error);
    return res.status(500).json({
      error: {
        type: 'api_error',
        message: 'Authentication failed',
      },
    });
  }
}

/**
 * Optional authentication - attach merchant if API key provided
 */
export async function optionalAuth(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    return next();
  }

  return authenticateApiKey(req, res, next);
}
