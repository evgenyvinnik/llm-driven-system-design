import crypto from 'node:crypto';
import { Router } from 'express';
import { getState } from '../store.js';
import { track } from '../lib/analytics.js';
import { trackingContext } from '../lib/context.js';
import { badRequest, notFound } from '../lib/errors.js';

const router = Router();

function findKey(id) {
  const key = getState().keys.find((candidate) => candidate.id === id);
  if (!key) throw notFound('API key not found.');
  return key;
}

router.get('/keys', (_req, res) => {
  res.json({ keys: getState().keys });
});

// The full secret is returned once, in this response, and never stored.
router.post('/keys', (req, res) => {
  const state = getState();
  const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
  if (!name || name.length > 60) throw badRequest('Key name must be 1–60 characters.');

  const secret = `sk-nw-${crypto.randomBytes(24).toString('base64url')}`;
  const key = {
    id: `key_${crypto.randomBytes(4).toString('hex')}`,
    name,
    hint: `sk-nw-…${secret.slice(-4)}`,
    status: 'active',
    createdBy: req.user.id,
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
  };
  state.keys.unshift(key);
  track('api_key_created', { key_id: key.id, key_count: state.keys.length }, trackingContext(req));
  res.status(201).json({ key, secret });
});

router.patch('/keys/:id', (req, res) => {
  const key = findKey(req.params.id);
  if (req.body.status !== undefined) {
    if (!['active', 'disabled'].includes(req.body.status)) throw badRequest('Status must be active or disabled.');
    key.status = req.body.status;
  }
  if (req.body.name !== undefined) {
    const name = String(req.body.name).trim();
    if (!name || name.length > 60) throw badRequest('Key name must be 1–60 characters.');
    key.name = name;
  }
  res.json(key);
});

router.delete('/keys/:id', (req, res) => {
  const state = getState();
  const key = findKey(req.params.id);
  state.keys = state.keys.filter((candidate) => candidate.id !== key.id);
  track('api_key_deleted', { key_id: key.id }, trackingContext(req));
  res.status(204).end();
});

export default router;
