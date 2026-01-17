// Authentication middleware

export function requireAuth(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  next();
}

export function optionalAuth(req, res, next) {
  // Just continue - session may or may not have userId
  next();
}

export function requireAdmin(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  // Would need to check user role from database
  // For now, just pass through
  next();
}

export default {
  requireAuth,
  optionalAuth,
  requireAdmin,
};
