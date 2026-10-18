// Development-only helpers used by the Dev toolbar.
import { Router } from 'express';
import { getState, resetState } from '../store.js';
import { clearEvents, track } from '../lib/analytics.js';
import { debit } from '../lib/billing.js';
import { getModel, roundCents } from '../lib/catalog.js';
import { badRequest } from '../lib/errors.js';
import { computeRunway } from '../lib/runway.js';
import { recordUsage } from '../lib/usage.js';

const router = Router();
const HOURS_PER_DAY = 24;
const SIMULATED_MODEL = 'nova-medium';
const INPUT_TOKENS_PER_REQUEST = 260;

router.post('/dev/reset', (_req, res) => {
  resetState();
  res.json({ ok: true });
});

router.post('/dev/clear-events', (_req, res) => {
  clearEvents();
  res.json({ ok: true });
});

// Fast-forward the org's own API traffic at its trailing daily spend, an hour at a time, so
// low-balance states, auto-reload and depletion can be demoed without waiting. Once the
// balance reaches $0 the remaining hours' requests are rejected, as the real API would.
// Spend is recorded on today's usage, so it doesn't change the trailing rate itself.
router.post('/dev/simulate-usage', (req, res) => {
  const state = getState();
  const days = Number(req.body?.days ?? 1);
  if (!Number.isInteger(days) || days < 1 || days > 14) throw badRequest('days must be a whole number from 1 to 14.');

  const model = getModel(SIMULATED_MODEL);
  const { avgDailySpendCents } = computeRunway(state);
  const hourlyCents = roundCents(avgDailySpendCents / HOURS_PER_DAY);
  const centsPerOutputToken = (5 * model.inputPerMTokCents + model.outputPerMTokCents) / 1_000_000;
  const requestsPerHour = Math.round((5 * (hourlyCents / centsPerOutputToken)) / INPUT_TOKENS_PER_REQUEST);
  const context = { orgId: state.org.id };

  let spentCents = 0;
  let rejectedHours = 0;
  for (let hour = 0; hour < days * HOURS_PER_DAY && hourlyCents > 0; hour += 1) {
    if (state.billing.balanceCents <= 0) {
      rejectedHours += 1;
      continue;
    }
    debit(state, hourlyCents, { cause: 'api_traffic', context });
    spentCents = roundCents(spentCents + hourlyCents);
  }

  if (spentCents > 0) {
    const outputTokens = Math.round(spentCents / centsPerOutputToken);
    recordUsage(state, {
      model: model.id,
      inputTokens: outputTokens * 5,
      outputTokens,
      costCents: spentCents,
      requests: Math.round((outputTokens * 5) / INPUT_TOKENS_PER_REQUEST),
    });
  }
  if (rejectedHours > 0) {
    track('api_requests_rejected', { reason: 'credit_balance_too_low', surface: 'api', count: requestsPerHour * rejectedHours }, context);
  }

  res.json({ days, spentCents, rejectedHours, balanceCents: state.billing.balanceCents });
});

export default router;
