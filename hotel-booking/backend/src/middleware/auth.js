const authService = require('../services/authService');

// Authentication middleware
async function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const token = authHeader.substring(7);

  try {
    const user = await authService.validateSession(token);

    if (!user) {
      return res.status(401).json({ error: 'Invalid or expired session' });
    }

    req.user = user;
    req.token = token;
    next();
  } catch (error) {
    console.error('Authentication error:', error);
    res.status(500).json({ error: 'Authentication error' });
  }
}

// Optional authentication middleware
async function optionalAuth(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return next();
  }

  const token = authHeader.substring(7);

  try {
    const user = await authService.validateSession(token);
    if (user) {
      req.user = user;
      req.token = token;
    }
  } catch (error) {
    console.error('Optional auth error:', error);
  }

  next();
}

// Role-based authorization middleware
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }

    next();
  };
}

// Hotel admin middleware (must own the hotel or be admin)
function requireHotelOwner(hotelIdParam = 'hotelId') {
  return async (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    // System admin can access all hotels
    if (req.user.role === 'admin') {
      return next();
    }

    // Hotel admin must own the hotel
    if (req.user.role !== 'hotel_admin') {
      return res.status(403).json({ error: 'Hotel admin access required' });
    }

    // hotelIdParam can be in params or body
    const hotelId = req.params[hotelIdParam] || req.body.hotelId;

    if (!hotelId) {
      return res.status(400).json({ error: 'Hotel ID required' });
    }

    const db = require('../models/db');
    const result = await db.query(
      'SELECT id FROM hotels WHERE id = $1 AND owner_id = $2',
      [hotelId, req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(403).json({ error: 'Access denied to this hotel' });
    }

    next();
  };
}

module.exports = {
  authenticate,
  optionalAuth,
  requireRole,
  requireHotelOwner,
};
