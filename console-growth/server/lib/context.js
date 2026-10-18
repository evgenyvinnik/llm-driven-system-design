// Request context. There is no login: every request acts as the seeded user in the seeded org.
import { getState } from '../store.js';

export function attachContext(req, _res, next) {
  const state = getState();
  req.user = state.users.find((user) => user.id === state.currentUserId);
  req.org = state.org;
  req.sessionId = req.get('x-session-id') ?? null;
  next();
}

// The identity fields every server-side event carries.
export function trackingContext(req) {
  return {
    userId: req.user?.id ?? null,
    orgId: req.org?.id ?? null,
    sessionId: req.sessionId ?? null,
  };
}
