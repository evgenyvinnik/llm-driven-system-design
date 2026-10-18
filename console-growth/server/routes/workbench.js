import crypto from 'node:crypto';
import { Router } from 'express';
import { getState } from '../store.js';
import { MODELS, costCents, getModel } from '../lib/catalog.js';
import { track } from '../lib/analytics.js';
import { trackingContext } from '../lib/context.js';
import { debit } from '../lib/billing.js';
import { recordUsage } from '../lib/usage.js';
import { ApiError, badRequest } from '../lib/errors.js';
import { generateCompletion } from '../lib/mockModel.js';

const router = Router();

router.get('/workbench/models', (_req, res) => {
  res.json({ models: MODELS });
});

// Workbench runs are billed like API calls: they draw down the org's prepaid credits.
router.post('/workbench/complete', (req, res) => {
  const state = getState();
  const { model: modelId, system = '', prompt, temperature = 1, maxTokens = 512 } = req.body;
  const model = getModel(modelId);
  if (!model) throw badRequest(`Unknown model "${modelId}".`);
  if (typeof prompt !== 'string' || !prompt.trim()) throw badRequest('Prompt is required.');
  if (typeof temperature !== 'number' || temperature < 0 || temperature > 1) throw badRequest('Temperature must be between 0 and 1.');
  if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 4096) throw badRequest('Max tokens must be between 1 and 4096.');

  if (state.billing.balanceCents <= 0) {
    track('api_requests_rejected', { reason: 'credit_balance_too_low', surface: 'workbench', model: model.id, count: 1 }, trackingContext(req));
    throw new ApiError(
      402,
      'credit_balance_too_low',
      'Your credit balance is too low to access the API. Add credits in Settings → Billing.',
    );
  }

  const completion = generateCompletion({ system, prompt, maxTokens });
  const cost = costCents(model, completion.inputTokens, completion.outputTokens);
  const context = trackingContext(req);
  recordUsage(state, { model: model.id, inputTokens: completion.inputTokens, outputTokens: completion.outputTokens, costCents: cost });
  const { balanceCents } = debit(state, cost, { cause: 'workbench', context });

  track(
    'workbench_run',
    { model: model.id, input_tokens: completion.inputTokens, output_tokens: completion.outputTokens, cost_cents: cost },
    context,
  );

  res.json({
    id: `msg_${crypto.randomBytes(6).toString('hex')}`,
    model: model.id,
    output: completion.output,
    stopReason: completion.stopReason,
    usage: { inputTokens: completion.inputTokens, outputTokens: completion.outputTokens },
    costCents: cost,
    balanceCents,
  });
});

export default router;
