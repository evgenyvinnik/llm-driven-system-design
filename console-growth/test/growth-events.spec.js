// The events behind both experiments' metrics, end to end through the API.
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../server/app.js';
import { getState, resetState } from '../server/store.js';
import { clearEvents, getEvents } from '../server/lib/analytics.js';

const app = createApp();
const eventsNamed = (name) => getEvents({ event: name, limit: 1_000 });

describe('growth instrumentation', () => {
  beforeEach(() => {
    resetState();
    clearEvents();
  });

  describe('what the experiments read', () => {
    it('GET /api/billing includes the runway', async () => {
      const res = await request(app).get('/api/billing');
      assert.equal(res.body.runway.atRisk, true);
      assert.equal(res.body.runway.daysLeft, 2.8);
      assert.deepEqual(res.body.runway.suggestedAutoReload, { thresholdCents: 500, amountCents: 2_000 });
    });

    it('GET /api/limits includes last week’s 429s', async () => {
      const res = await request(app).get('/api/limits');
      assert.equal(res.body.rateLimit.rateLimited7d, 412);
      assert.equal(res.body.rateLimit.sharePct, 3.6);
    });
  });

  describe('credits_purchased and usage_tier_upgraded', () => {
    it('records the source and the tier change for a nudge purchase', async () => {
      await request(app).post('/api/billing/credits').send({ amountCents: 1_500, source: 'rate_limit_nudge' });

      const [purchase] = eventsNamed('credits_purchased');
      assert.deepEqual(purchase.props, {
        amount_cents: 1_500,
        balance_before_cents: 384,
        source: 'rate_limit_nudge',
        tier_before: 1,
        tier_after: 2,
      });
      const [upgrade] = eventsNamed('usage_tier_upgraded');
      assert.deepEqual(upgrade.props, { from_tier: 1, to_tier: 2, via: 'purchase', source: 'rate_limit_nudge' });
      assert.equal(upgrade.orgId, 'org_northwind');
    });

    it('does not record a tier change when the purchase falls short', async () => {
      await request(app).post('/api/billing/credits').send({ amountCents: 1_000, source: 'billing_page' });
      assert.equal(eventsNamed('usage_tier_upgraded').length, 0);
      assert.equal(eventsNamed('credits_purchased')[0].props.tier_after, 1);
    });

    it('records unknown sources as "other" instead of trusting the client', async () => {
      await request(app).post('/api/billing/credits').send({ amountCents: 1_000, source: '<script>' });
      assert.equal(eventsNamed('credits_purchased')[0].props.source, 'other');
    });
  });

  describe('auto_reload_updated and auto_reload_charged', () => {
    it('records turning auto-reload on from the banner, and the immediate charge', async () => {
      await request(app).put('/api/billing/auto-reload').send({ enabled: true, thresholdCents: 500, amountCents: 2_000, source: 'runway_banner' });

      const [update] = eventsNamed('auto_reload_updated');
      assert.equal(update.props.enabled, true);
      assert.equal(update.props.was_enabled, false);
      assert.equal(update.props.source, 'runway_banner');
      assert.equal(update.props.balance_cents, 384);

      const [charge] = eventsNamed('auto_reload_charged');
      assert.equal(charge.props.trigger, 'enabled');
      assert.equal(charge.props.amount_cents, 2_000);
    });

    it('distinguishes editing settings from turning it on', async () => {
      const state = getState();
      state.billing.autoReload.enabled = true;
      state.billing.balanceCents = 5_000;
      await request(app).put('/api/billing/auto-reload').send({ enabled: true, thresholdCents: 1_000, amountCents: 2_500, source: 'billing_page' });
      assert.equal(eventsNamed('auto_reload_updated')[0].props.was_enabled, true);
      assert.equal(eventsNamed('auto_reload_charged').length, 0);
    });
  });

  describe('credit_balance_depleted and api_requests_rejected', () => {
    it('records a depletion once, when a request takes the balance to $0', async () => {
      getState().billing.balanceCents = 0.0001;
      const body = { model: 'nova-large', prompt: 'Draft a migration plan.' };

      const first = await request(app).post('/api/workbench/complete').send(body);
      assert.equal(first.status, 200);
      const second = await request(app).post('/api/workbench/complete').send(body);
      assert.equal(second.status, 402);

      const depletions = eventsNamed('credit_balance_depleted');
      assert.equal(depletions.length, 1);
      assert.deepEqual(depletions[0].props, { balance_before_cents: 0.0001, cause: 'workbench', auto_reload_enabled: false });
      const [rejected] = eventsNamed('api_requests_rejected');
      assert.equal(rejected.props.reason, 'credit_balance_too_low');
      assert.equal(rejected.props.surface, 'workbench');
    });

    it('simulated traffic runs the seeded org out of credits within 3 days', async () => {
      const res = await request(app).post('/api/dev/simulate-usage').send({ days: 3 });
      assert.ok(res.body.balanceCents <= 0);
      assert.ok(res.body.rejectedHours > 0);
      assert.equal(eventsNamed('credit_balance_depleted').length, 1);
      assert.equal(eventsNamed('credit_balance_depleted')[0].props.cause, 'api_traffic');
    });

    it('with auto-reload on, the same traffic never runs out', async () => {
      await request(app).put('/api/billing/auto-reload').send({ enabled: true, thresholdCents: 500, amountCents: 2_000, source: 'runway_banner' });
      const res = await request(app).post('/api/dev/simulate-usage').send({ days: 3 });
      assert.ok(res.body.balanceCents > 0);
      assert.equal(res.body.rejectedHours, 0);
      assert.equal(eventsNamed('credit_balance_depleted').length, 0);
    });
  });
});
