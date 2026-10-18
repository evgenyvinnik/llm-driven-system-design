// The readout's population and window rules, on a hand-built event log.
import assert from 'node:assert/strict';
import { computeReadout, firstExposures } from '../server/lib/readout.js';

const T0 = Date.parse('2026-10-01T12:00:00Z');
const at = (days) => new Date(T0 + days * 86_400_000).toISOString();

function exposure(orgId, variant, days = 0, props = {}) {
  return {
    event: '$exposure',
    ts: at(days),
    orgId,
    props: { experiment: 'credit_runway_autoreload', variant, unit_id: orgId, overridden: false, state: 'warning', ...props },
  };
}

const event = (name, orgId, days, props = {}) => ({ event: name, ts: at(days), orgId, props });

describe('readout', () => {
  it('uses each org’s first exposure and drops overridden exposures', () => {
    const { exposures, overridden } = firstExposures(
      [exposure('org_a', 'treatment', 2), exposure('org_a', 'treatment', 1), exposure('org_b', 'control', 0, { overridden: true })],
      'credit_runway_autoreload',
    );
    assert.equal(exposures.size, 1);
    assert.equal(exposures.get('org_a').ts, at(1));
    assert.equal(overridden, 1);
  });

  it('drops an org seen in both variants', () => {
    const { exposures, contaminated } = firstExposures(
      [exposure('org_a', 'treatment'), exposure('org_a', 'control', 1)],
      'credit_runway_autoreload',
    );
    assert.equal(exposures.size, 0);
    assert.equal(contaminated, 1);
  });

  it('computes the 14-day depletion rate per arm, counting only events inside the window', () => {
    const events = [
      exposure('org_a', 'control'),
      event('credit_balance_depleted', 'org_a', 3),
      exposure('org_b', 'control'),
      event('credit_balance_depleted', 'org_b', 15), // after the window
      exposure('org_c', 'treatment'),
      event('auto_reload_updated', 'org_c', 0.01, { enabled: true, was_enabled: false }),
      event('auto_reload_charged', 'org_c', 0.01, { amount_cents: 2_000 }),
      exposure('org_d', 'treatment'),
      event('credit_balance_depleted', 'org_d', -1), // before exposure
    ];
    const { arms } = computeReadout(events, 'credit_runway_autoreload');

    assert.equal(arms.control.exposed, 2);
    assert.equal(arms.control.metrics.depleted_within_14d.value, 0.5);
    assert.equal(arms.treatment.metrics.depleted_within_14d.value, 0);
    assert.equal(arms.treatment.metrics.auto_reload_turned_on_within_7d.value, 0.5);
    assert.equal(arms.treatment.metrics.credits_bought_per_org_28d_cents.value, 1_000);
  });

  it('leaves orgs first exposed at $0 out of the depletion metric but not the others', () => {
    const events = [
      exposure('org_a', 'treatment', 0, { state: 'depleted' }),
      event('credits_purchased', 'org_a', 0.1, { amount_cents: 2_500 }),
      exposure('org_b', 'treatment'),
    ];
    const { arms } = computeReadout(events, 'credit_runway_autoreload');
    assert.equal(arms.treatment.metrics.depleted_within_14d.units, 1);
    assert.equal(arms.treatment.metrics.credits_bought_per_org_28d_cents.units, 2);
    assert.equal(arms.treatment.metrics.credits_bought_per_org_28d_cents.value, 1_250);
  });

  it('computes the tier-upgrade rate for the rate-limit nudge', () => {
    const nudge = (orgId, variant) => ({
      ...exposure(orgId, variant),
      props: { experiment: 'rate_limit_upgrade_nudge', variant, unit_id: orgId, overridden: false },
    });
    const events = [
      nudge('org_a', 'treatment'),
      event('usage_tier_upgraded', 'org_a', 1, { from_tier: 1, to_tier: 2 }),
      nudge('org_b', 'treatment'),
      nudge('org_c', 'control'),
    ];
    const { arms } = computeReadout(events, 'rate_limit_upgrade_nudge');
    assert.equal(arms.treatment.metrics.tier_upgraded_within_14d.value, 0.5);
    assert.equal(arms.control.metrics.tier_upgraded_within_14d.value, 0);
  });
});
