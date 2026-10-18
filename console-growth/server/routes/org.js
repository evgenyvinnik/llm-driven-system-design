import { Router } from 'express';
import { getState } from '../store.js';
import { track } from '../lib/analytics.js';
import { trackingContext } from '../lib/context.js';
import { badRequest } from '../lib/errors.js';

const router = Router();
const ROLES = ['admin', 'developer', 'billing', 'viewer'];

router.get('/me', (req, res) => {
  res.json({ user: req.user, org: req.org });
});

router.get('/org', (req, res) => {
  res.json(req.org);
});

router.patch('/org', (req, res) => {
  const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
  if (!name || name.length > 80) throw badRequest('Organization name must be 1–80 characters.');
  req.org.name = name;
  res.json(req.org);
});

router.get('/org/members', (_req, res) => {
  const state = getState();
  res.json({ members: state.users, invites: state.invites });
});

router.post('/org/invites', (req, res) => {
  const state = getState();
  const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const role = req.body.role ?? 'developer';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw badRequest('Enter a valid email address.');
  if (!ROLES.includes(role)) throw badRequest(`Role must be one of ${ROLES.join(', ')}.`);
  if (state.users.some((user) => user.email === email) || state.invites.some((invite) => invite.email === email)) {
    throw badRequest('That person is already a member or has a pending invite.', 'already_invited');
  }
  const invite = {
    id: `inv_${Date.now().toString(36)}`,
    email,
    role,
    invitedBy: req.user.id,
    createdAt: new Date().toISOString(),
  };
  state.invites.push(invite);
  track('member_invited', { role }, trackingContext(req));
  res.status(201).json(invite);
});

export default router;
