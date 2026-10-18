// The experiment framework: registry rules, deterministic assignment, overrides, exposure.
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../server/app.js';
import { EXPERIMENTS } from '../server/experiments.config.js';
import { bucketFor, getAssignment, getExperiment, logExposure, variantForBucket } from '../server/lib/experiments.js';
import { clearEvents, getEvents } from '../server/lib/analytics.js';
import { resetState } from '../server/store.js';

const app = createApp();

// Just enough of an Express request for getAssignment().
function fakeRequest({ userId = 'user_ahmad', orgId = 'org_northwind', overrides } = {}) {
  const headers = overrides ? { 'x-experiment-overrides': JSON.stringify(overrides) } : {};
  return { user: { id: userId }, org: { id: orgId }, sessionId: 's1', get: (name) => headers[name.toLowerCase()] };
}

describe('experiment registry', () => {
  it('has unique keys', () => {
    const keys = EXPERIMENTS.map((experiment) => experiment.key);
    assert.equal(new Set(keys).size, keys.length);
  });

  for (const experiment of EXPERIMENTS) {
    it(`${experiment.key} is well formed`, () => {
      assert.match(experiment.key, /^[a-z][a-z0-9_]+$/);
      assert.equal(experiment.variants[0], 'control', 'the first variant must be the control');
      assert.equal(experiment.weights.length, experiment.variants.length);
      assert.ok(experiment.weights.every((weight) => weight >= 0));
      assert.ok(['user', 'org'].includes(experiment.unit));
      assert.equal(typeof experiment.enabled, 'boolean');
    });
  }

  it('assigns both growth experiments by org, so teammates share a variant', () => {
    assert.equal(getExperiment('credit_runway_autoreload').unit, 'org');
    assert.equal(getExperiment('rate_limit_upgrade_nudge').unit, 'org');
  });
});

describe('assignment', () => {
  it('gives the same unit the same bucket every time', () => {
    assert.equal(bucketFor('credit_runway_autoreload', 'org_1'), bucketFor('credit_runway_autoreload', 'org_1'));
  });

  it('maps buckets to variants by weight', () => {
    const experiment = { variants: ['control', 'treatment'], weights: [90, 10] };
    assert.equal(variantForBucket(experiment, 0), 'control');
    assert.equal(variantForBucket(experiment, 8_999), 'control');
    assert.equal(variantForBucket(experiment, 9_000), 'treatment');
    assert.equal(variantForBucket(experiment, 9_999), 'treatment');
  });

  it('splits 10,000 orgs close to 50/50', () => {
    const experiment = getExperiment('credit_runway_autoreload');
    let treatment = 0;
    for (let i = 0; i < 10_000; i += 1) {
      if (variantForBucket(experiment, bucketFor(experiment.key, `org_${i}`)) === 'treatment') treatment += 1;
    }
    assert.ok(Math.abs(treatment - 5_000) < 200, `treatment got ${treatment}`);
  });

  it('assigns different experiments independently', () => {
    const [a, b] = ['credit_runway_autoreload', 'rate_limit_upgrade_nudge'].map(getExperiment);
    let same = 0;
    for (let i = 0; i < 10_000; i += 1) {
      const unit = `org_${i}`;
      if (variantForBucket(a, bucketFor(a.key, unit)) === variantForBucket(b, bucketFor(b.key, unit))) same += 1;
    }
    // Independent 50/50 splits agree about half the time.
    assert.ok(Math.abs(same - 5_000) < 200, `agreed ${same} times`);
  });

  it('hashes the org id for org experiments and the user id for user experiments', () => {
    const teammate = fakeRequest({ userId: 'user_jordan' });
    assert.equal(getAssignment(teammate, 'credit_runway_autoreload').unitId, 'org_northwind');
    assert.equal(getAssignment(teammate, 'dashboard_welcome_copy').unitId, 'user_jordan');
    assert.equal(
      getAssignment(teammate, 'credit_runway_autoreload').variant,
      getAssignment(fakeRequest(), 'credit_runway_autoreload').variant,
    );
  });

  it('applies a valid override and flags it', () => {
    const natural = getAssignment(fakeRequest(), 'credit_runway_autoreload');
    const other = natural.assigned === 'control' ? 'treatment' : 'control';
    const forced = getAssignment(fakeRequest({ overrides: { credit_runway_autoreload: other } }), 'credit_runway_autoreload');
    assert.equal(forced.variant, other);
    assert.equal(forced.assigned, natural.assigned);
    assert.equal(forced.overridden, true);
  });

  it('ignores overrides naming a variant that does not exist', () => {
    const forced = getAssignment(fakeRequest({ overrides: { credit_runway_autoreload: 'treatment_b' } }), 'credit_runway_autoreload');
    assert.equal(forced.overridden, false);
  });

  it('throws for an unregistered key', () => {
    assert.throws(() => getAssignment(fakeRequest(), 'not_registered'), /Unknown experiment/);
  });

  it('gives everyone the control and logs nothing when an experiment is switched off', () => {
    const experiment = getExperiment('rate_limit_upgrade_nudge');
    experiment.enabled = false;
    try {
      const req = fakeRequest({ overrides: { rate_limit_upgrade_nudge: 'treatment' } });
      assert.equal(getAssignment(req, experiment.key).variant, 'control');
      assert.equal(logExposure(req, experiment.key), null);
    } finally {
      experiment.enabled = true;
    }
  });
});

describe('POST /api/experiments/:key/exposure', () => {
  beforeEach(() => {
    resetState();
    clearEvents();
  });

  it('logs $exposure with the server-resolved variant, whatever the client claims', async () => {
    const res = await request(app)
      .post('/api/experiments/credit_runway_autoreload/exposure')
      .set('X-Experiment-Overrides', JSON.stringify({ credit_runway_autoreload: 'treatment' }))
      .send({ props: { surface: 'app_banner', variant: 'control' }, path: '/usage' });
    assert.equal(res.status, 202);

    const [exposure] = getEvents({ event: '$exposure' });
    assert.equal(exposure.props.experiment, 'credit_runway_autoreload');
    assert.equal(exposure.props.variant, 'treatment');
    assert.equal(exposure.props.overridden, true);
    assert.equal(exposure.props.unit_id, 'org_northwind');
    assert.equal(exposure.props.surface, 'app_banner');
    assert.equal(exposure.props.path, '/usage');
    assert.equal(exposure.source, 'client');
    assert.equal(exposure.orgId, 'org_northwind');
  });

  it('returns 404 for an unknown experiment', async () => {
    const res = await request(app).post('/api/experiments/nope/exposure').send({});
    assert.equal(res.status, 404);
  });
});
