export function isAuthenticated(req, res, next) {
  if (req.session && req.session.userId) {
    return next();
  }
  return res.status(401).json({ error: 'Authentication required' });
}

export function isAdmin(req, res, next) {
  if (req.session && req.session.role === 'admin') {
    return next();
  }
  return res.status(403).json({ error: 'Admin access required' });
}

export function isShopOwner(req, res, next) {
  // This middleware checks if user owns the shop they're trying to access
  // It should be used after isAuthenticated
  const shopId = parseInt(req.params.shopId || req.body.shopId);
  if (req.session.shopIds && req.session.shopIds.includes(shopId)) {
    return next();
  }
  return res.status(403).json({ error: 'You do not own this shop' });
}
