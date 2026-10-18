import { Router } from 'express';
import { getState } from '../store.js';
import { MODELS } from '../lib/catalog.js';
import { nextTierFor, tierFor } from '../lib/billing.js';
import { monthToDateSpendCents, rateLimitSummary, summarizeUsage } from '../lib/usage.js';
import { badRequest } from '../lib/errors.js';

const router = Router();
const ALLOWED_RANGES = [7, 14, 21];

router.get('/usage', (req, res) => {
  const days = Number(req.query.days ?? 7);
  if (!ALLOWED_RANGES.includes(days)) throw badRequest(`days must be one of ${ALLOWED_RANGES.join(', ')}.`);
  res.json(summarizeUsage(getState(), { days }));
});

router.get('/limits', (_req, res) => {
  const state = getState();
  const now = new Date();
  const tier = tierFor(state.billing, now);
  res.json({
    tier,
    nextTier: nextTierFor(state.billing, now),
    cumulativePurchasedCents: state.billing.cumulativePurchasedCents,
    firstPurchaseAt: state.billing.firstPurchaseAt,
    monthlySpend: { limitCents: tier.monthlySpendLimitCents, usedCents: monthToDateSpendCents(state, now) },
    rateLimit: rateLimitSummary(state, now),
    models: MODELS.map((model) => ({ model: model.id, name: model.name, rpm: tier.rpm, itpm: tier.itpm, otpm: tier.otpm })),
  });
});

export default router;
