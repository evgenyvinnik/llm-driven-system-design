import authService from '../services/authService.js';

// Authentication middleware
export async function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const user = await authService.validateSession(token);

  if (!user) {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }

  req.user = user;
  req.token = token;
  next();
}

// Require rider role
export function requireRider(req, res, next) {
  if (req.user.userType !== 'rider') {
    return res.status(403).json({ error: 'Rider access required' });
  }
  next();
}

// Require driver role
export function requireDriver(req, res, next) {
  if (req.user.userType !== 'driver') {
    return res.status(403).json({ error: 'Driver access required' });
  }
  next();
}
