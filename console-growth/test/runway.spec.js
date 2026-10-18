// Credit runway: the eligibility rule for credit_runway_autoreload and the suggested settings.
import assert from 'node:assert/strict';
import { buildSeed } from '../server/seed.js';
import { RUNWAY_WARNING_DAYS, computeRunway, suggestAutoReload } from '../server/lib/runway.js';
import { recordUsage } from '../server/lib/usage.js';

const NOW = new Date('2026-10-16T15:30:00Z');

describe('computeRunway', () => {
  let state;
  beforeEach(() => {
    state = buildSeed(NOW);
  });

  it('puts the seeded org about 2.8 days from running out, so it is at risk', () => {
    const runway = computeRunway(state, NOW);
    assert.equal(runway.avgDailySpendCents, 137.14);
    assert.equal(runway.daysLeft, 2.8);
    assert.equal(runway.depleted, false);
    assert.equal(runway.atRisk, true);
    assert.equal(new Date(runway.runsOutAt).toISOString().slice(0, 10), '2026-10-19');
  });

  it('ignores spend from today, which is only partly over', () => {
    const before = computeRunway(state, NOW).avgDailySpendCents;
    recordUsage(state, { model: 'nova-large', inputTokens: 1_000_000, outputTokens: 200_000, costCents: 3_000, now: NOW });
    assert.equal(computeRunway(state, NOW).avgDailySpendCents, before);
  });

  it('is not at risk with auto-reload on', () => {
    state.billing.autoReload.enabled = true;
    assert.equal(computeRunway(state, NOW).atRisk, false);
  });

  it('is not at risk with more than a week of credit left', () => {
    state.billing.balanceCents = 137.14 * (RUNWAY_WARNING_DAYS + 1);
    assert.equal(computeRunway(state, NOW).atRisk, false);
  });

  it('is at risk at exactly the warning threshold', () => {
    state.billing.balanceCents = 137.14 * RUNWAY_WARNING_DAYS;
    const runway = computeRunway(state, NOW);
    assert.equal(runway.daysLeft, RUNWAY_WARNING_DAYS);
    assert.equal(runway.atRisk, true);
  });

  it('marks a balance at or below $0 as depleted and at risk', () => {
    state.billing.balanceCents = -3.2;
    const runway = computeRunway(state, NOW);
    assert.equal(runway.daysLeft, 0);
    assert.equal(runway.depleted, true);
    assert.equal(runway.atRisk, true);
  });

  it('has no runway estimate without recent spend, and no warning', () => {
    state.usage = [];
    const runway = computeRunway(state, NOW);
    assert.equal(runway.daysLeft, null);
    assert.equal(runway.runsOutAt, null);
    assert.equal(runway.atRisk, false);
  });

  it('never warns invoiced (Scale) orgs', () => {
    state.org.plan = 'scale';
    assert.equal(computeRunway(state, NOW).atRisk, false);
  });
});

describe('suggestAutoReload', () => {
  it('sizes the seeded org at a $5 threshold and a $20 reload', () => {
    assert.deepEqual(suggestAutoReload(137.14), { thresholdCents: 500, amountCents: 2_000 });
  });

  it('never goes below a $5 threshold or a $10 reload', () => {
    assert.deepEqual(suggestAutoReload(10), { thresholdCents: 500, amountCents: 1_000 });
  });

  it('caps the reload at $500 for heavy spenders', () => {
    assert.deepEqual(suggestAutoReload(10_000), { thresholdCents: 30_000, amountCents: 50_000 });
  });

  it('falls back to defaults without spend', () => {
    assert.deepEqual(suggestAutoReload(0), { thresholdCents: 500, amountCents: 2_000 });
  });
});
