const isAuthenticated = (req, res, next) => {
  if (req.session && req.session.userId) {
    return next();
  }
  return res.status(401).json({ error: 'Unauthorized' });
};

const isAdmin = (req, res, next) => {
  if (req.session && req.session.role === 'admin') {
    return next();
  }
  return res.status(403).json({ error: 'Forbidden' });
};

const hasSubscription = (req, res, next) => {
  if (req.session && req.session.subscriptionTier && req.session.subscriptionTier !== 'free') {
    const expiresAt = new Date(req.session.subscriptionExpiresAt);
    if (expiresAt > new Date()) {
      return next();
    }
  }
  return res.status(403).json({ error: 'Subscription required' });
};

module.exports = {
  isAuthenticated,
  isAdmin,
  hasSubscription
};
