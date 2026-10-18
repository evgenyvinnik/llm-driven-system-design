// Smoke tests for the starter API: the product works before any experiment is added.
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../server/app.js';
import { getState, resetState } from '../server/store.js';
import { clearEvents, getEvents } from '../server/lib/analytics.js';

const app = createApp();

describe('Console API', () => {
  beforeEach(() => {
    resetState();
    clearEvents();
  });

  it('reports health', async () => {
    const res = await request(app).get('/api/health');
    assert.equal(res.status, 200);
  });

  it('acts as the seeded user and org', async () => {
    const res = await request(app).get('/api/me');
    assert.equal(res.body.user.id, 'user_ahmad');
    assert.equal(res.body.org.name, 'Northwind Labs');
  });

  describe('API keys', () => {
    it('returns the secret once on create and never in the list', async () => {
      const created = await request(app).post('/api/keys').send({ name: 'ci' });
      assert.equal(created.status, 201);
      assert.match(created.body.secret, /^sk-nw-/);

      const list = await request(app).get('/api/keys');
      assert.equal(list.body.keys.length, 4);
      assert.ok(list.body.keys.every((key) => !('secret' in key)));
    });

    it('rejects an empty name', async () => {
      const res = await request(app).post('/api/keys').send({ name: '  ' });
      assert.equal(res.status, 400);
    });

    it('deletes a key', async () => {
      const res = await request(app).delete('/api/keys/key_laptop');
      assert.equal(res.status, 204);
      assert.ok(!getState().keys.some((key) => key.id === 'key_laptop'));
    });
  });

  describe('Workbench', () => {
    it('returns a completion and bills it to the balance', async () => {
      const before = getState().billing.balanceCents;
      const res = await request(app).post('/api/workbench/complete').send({ model: 'nova-large', prompt: 'Summarize our Q3 incident report.' });
      assert.equal(res.status, 200);
      assert.ok(res.body.output.length > 0);
      assert.ok(res.body.costCents > 0);
      assert.equal(res.body.balanceCents, Math.round((before - res.body.costCents) * 10_000) / 10_000);
    });

    it('is deterministic for the same prompt', async () => {
      const body = { model: 'nova-small', prompt: 'Name three sorting algorithms.' };
      const first = await request(app).post('/api/workbench/complete').send(body);
      const second = await request(app).post('/api/workbench/complete').send(body);
      assert.equal(first.body.output, second.body.output);
    });

    it('fails with 402 once the balance is used up', async () => {
      getState().billing.balanceCents = 0;
      const res = await request(app).post('/api/workbench/complete').send({ model: 'nova-medium', prompt: 'Hello' });
      assert.equal(res.status, 402);
      assert.equal(res.body.error.type, 'credit_balance_too_low');
    });

    it('rejects an unknown model', async () => {
      const res = await request(app).post('/api/workbench/complete').send({ model: 'gpt-9', prompt: 'Hello' });
      assert.equal(res.status, 400);
    });
  });

  describe('Usage and limits', () => {
    it('summarizes the last 7 days, including 429s', async () => {
      const res = await request(app).get('/api/usage?days=7');
      assert.equal(res.status, 200);
      assert.equal(res.body.daily.length, 7);
      assert.equal(res.body.totals.rateLimited, 412);
    });

    it('rejects unsupported ranges', async () => {
      const res = await request(app).get('/api/usage?days=30');
      assert.equal(res.status, 400);
    });

    it('reports Tier 1 with $15 to go for Tier 2', async () => {
      const res = await request(app).get('/api/limits');
      assert.equal(res.body.tier.tier, 1);
      assert.equal(res.body.nextTier.tier, 2);
      assert.equal(res.body.nextTier.remainingCents, 1_500);
    });
  });

  describe('Billing', () => {
    it('adds purchased credits to the balance', async () => {
      const res = await request(app).post('/api/billing/credits').send({ amountCents: 2_000 });
      assert.equal(res.status, 201);
      assert.equal(res.body.billing.balanceCents, 2_384);
      assert.equal(res.body.billing.cumulativePurchasedCents, 4_500);
    });

    it('rejects purchases under $5', async () => {
      const res = await request(app).post('/api/billing/credits').send({ amountCents: 100 });
      assert.equal(res.status, 400);
    });

    it('reloads immediately when auto-reload is turned on below the threshold', async () => {
      const res = await request(app).put('/api/billing/auto-reload').send({ enabled: true, thresholdCents: 500, amountCents: 2_000 });
      assert.equal(res.status, 200);
      assert.equal(res.body.charged.amountCents, 2_000);
      assert.equal(res.body.billing.balanceCents, 2_384);
    });

    it('reloads when usage takes the balance under the threshold', async () => {
      const state = getState();
      state.billing.autoReload = { enabled: true, thresholdCents: 500, amountCents: 1_000 };
      state.billing.balanceCents = 500.001;
      await request(app).post('/api/workbench/complete').send({ model: 'nova-large', prompt: 'Write a long design doc about caching.' });
      assert.ok(state.billing.balanceCents > 1_000);
      assert.equal(state.billing.transactions[0].type, 'auto_reload');
    });
  });

  describe('Experiments and events', () => {
    it('lists registered experiments with an assignment', async () => {
      const res = await request(app).get('/api/experiments');
      const example = res.body.experiments.find((experiment) => experiment.key === 'dashboard_welcome_copy');
      assert.ok(['control', 'treatment'].includes(example.variant));
      assert.equal(example.unitId, 'user_ahmad');
    });

    it('honors a Dev toolbar override', async () => {
      const res = await request(app)
        .get('/api/experiments')
        .set('X-Experiment-Overrides', JSON.stringify({ dashboard_welcome_copy: 'treatment' }));
      const example = res.body.experiments.find((experiment) => experiment.key === 'dashboard_welcome_copy');
      assert.equal(example.variant, 'treatment');
    });

    it('records client events with the user and org attached', async () => {
      const res = await request(app).post('/api/events').set('X-Session-Id', 's1').send({ event: 'page_viewed', props: { path: '/' } });
      assert.equal(res.status, 202);
      const [event] = getEvents({ event: 'page_viewed' });
      assert.equal(event.userId, 'user_ahmad');
      assert.equal(event.orgId, 'org_northwind');
      assert.equal(event.sessionId, 's1');
      assert.equal(event.source, 'client');
    });

    it('refuses reserved $ event names from the client', async () => {
      const res = await request(app).post('/api/events').send({ event: '$exposure', props: {} });
      assert.equal(res.status, 400);
    });
  });
});
