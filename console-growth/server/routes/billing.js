import { Router } from 'express';
import { getState } from '../store.js';
import { PLANS } from '../lib/catalog.js';
import { track } from '../lib/analytics.js';
import { trackingContext } from '../lib/context.js';
import { purchaseCredits, tierFor, updateAutoReload } from '../lib/billing.js';
import { computeRunway } from '../lib/runway.js';
import { badRequest } from '../lib/errors.js';

const router = Router();

function billingView(state) {
  const { billing, org } = state;
  return {
    plan: org.plan,
    balanceCents: billing.balanceCents,
    autoReload: billing.autoReload,
    paymentMethod: billing.paymentMethod,
    cumulativePurchasedCents: billing.cumulativePurchasedCents,
    tier: tierFor(billing).tier,
    runway: computeRunway(state),
    transactions: billing.transactions,
  };
}

router.get('/billing', (_req, res) => {
  res.json(billingView(getState()));
});

router.post('/billing/credits', (req, res) => {
  const state = getState();
  const result = purchaseCredits(state, req.body.amountCents, { source: req.body.source, context: trackingContext(req) });
  res.status(201).json({ ...result, billing: billingView(state) });
});

router.put('/billing/auto-reload', (req, res) => {
  const state = getState();
  if (typeof req.body.enabled !== 'boolean') throw badRequest('enabled must be true or false.');
  const result = updateAutoReload(state, req.body, { source: req.body.source, context: trackingContext(req) });
  res.json({ ...result, billing: billingView(state) });
});

router.get('/plans', (req, res) => {
  res.json({ current: req.org.plan, plans: PLANS });
});

router.post('/plans/scale/contact', (req, res) => {
  const message = typeof req.body.message === 'string' ? req.body.message.trim().slice(0, 2_000) : '';
  track('scale_contact_requested', { has_message: message.length > 0 }, trackingContext(req));
  res.status(202).json({ ok: true });
});

export default router;
