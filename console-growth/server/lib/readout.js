// Experiment readout: each experiment's metrics, computed from the event log the way the real
// analysis would be (EXPERIMENTS.md §4).
//
// 1. The analysis population is the units with an $exposure, not everyone assigned. A unit's
//    arm and start time t0 come from its first exposure.
//    - Overridden exposures (Dev toolbar) are QA traffic and are left out by default.
//    - A unit exposed in more than one variant is contaminated and dropped from both arms.
// 2. A metric looks only at the unit's events in (t0, t0 + windowDays]. Matching is by org for
//    org experiments and by user for user experiments.
// 3. 'rate' metrics are the share of exposed units with at least one matching event; 'sum'
//    metrics are the mean of a property per exposed unit, so non-converters count as zero.
const DAY_MS = 86_400_000;

const isCreditPurchase = (event) => event.event === 'credits_purchased' || event.event === 'auto_reload_charged';

export const METRICS = {
  credit_runway_autoreload: [
    {
      name: 'depleted_within_14d',
      role: 'primary',
      kind: 'rate',
      better: 'lower',
      windowDays: 14,
      // An org first exposed while already at $0 can't run out again until it recovers, so it
      // is outside this metric (its time to recover is a separate cut).
      eligible: (exposure) => exposure.props.state !== 'depleted',
      matches: (event) => event.event === 'credit_balance_depleted',
    },
    {
      name: 'auto_reload_turned_on_within_7d',
      role: 'secondary',
      kind: 'rate',
      better: 'higher',
      windowDays: 7,
      matches: (event) => event.event === 'auto_reload_updated' && event.props.enabled && !event.props.was_enabled,
    },
    {
      name: 'credits_bought_per_org_28d_cents',
      role: 'secondary',
      kind: 'sum',
      better: 'higher',
      windowDays: 28,
      matches: isCreditPurchase,
      value: (event) => event.props.amount_cents,
    },
    {
      name: 'auto_reload_turned_off_within_14d',
      role: 'guardrail',
      kind: 'rate',
      better: 'lower',
      windowDays: 14,
      matches: (event) => event.event === 'auto_reload_updated' && !event.props.enabled && event.props.was_enabled,
    },
    {
      name: 'requests_rejected_per_org_14d',
      role: 'guardrail',
      kind: 'sum',
      better: 'lower',
      windowDays: 14,
      matches: (event) => event.event === 'api_requests_rejected',
      value: (event) => event.props.count,
    },
  ],
  rate_limit_upgrade_nudge: [
    {
      name: 'tier_upgraded_within_14d',
      role: 'primary',
      kind: 'rate',
      better: 'higher',
      windowDays: 14,
      matches: (event) => event.event === 'usage_tier_upgraded',
    },
    {
      name: 'credits_bought_per_org_14d_cents',
      role: 'secondary',
      kind: 'sum',
      better: 'higher',
      windowDays: 14,
      matches: isCreditPurchase,
      value: (event) => event.props.amount_cents,
    },
  ],
};

function unitKey(event, unit) {
  return unit === 'org' ? event.orgId : event.userId;
}

/** First exposure per unit, as Map<unitId, exposureEvent>, plus counts of what was left out. */
export function firstExposures(events, experiment, { includeOverrides = false } = {}) {
  const firsts = new Map();
  const variantsSeen = new Map();
  let overridden = 0;
  for (const event of events) {
    if (event.event !== '$exposure' || event.props.experiment !== experiment) continue;
    if (event.props.overridden && !includeOverrides) {
      overridden += 1;
      continue;
    }
    const unitId = event.props.unit_id;
    if (!variantsSeen.has(unitId)) variantsSeen.set(unitId, new Set());
    variantsSeen.get(unitId).add(event.props.variant);
    const current = firsts.get(unitId);
    if (!current || event.ts < current.ts) firsts.set(unitId, event);
  }
  let contaminated = 0;
  for (const [unitId, variants] of variantsSeen) {
    if (variants.size > 1) {
      firsts.delete(unitId);
      contaminated += 1;
    }
  }
  return { exposures: firsts, overridden, contaminated };
}

function metricValue(metric, exposure, unitEvents) {
  const start = Date.parse(exposure.ts);
  const end = start + metric.windowDays * DAY_MS;
  const inWindow = unitEvents.filter((event) => {
    const ts = Date.parse(event.ts);
    return ts > start && ts <= end && metric.matches(event);
  });
  if (metric.kind === 'rate') return inWindow.length > 0 ? 1 : 0;
  return inWindow.reduce((sum, event) => sum + (metric.value(event) ?? 0), 0);
}

/**
 * @param events     the event log, any order
 * @param experiment key from METRICS
 * @returns {{ experiment, overridden, contaminated, arms: { [variant]: { exposed, metrics: { [name]: { units, value } } } } }}
 */
export function computeReadout(events, experiment, { includeOverrides = false, unit = 'org' } = {}) {
  const metrics = METRICS[experiment];
  if (!metrics) throw new Error(`No metrics defined for "${experiment}".`);
  const { exposures, overridden, contaminated } = firstExposures(events, experiment, { includeOverrides });

  const eventsByUnit = new Map();
  for (const event of events) {
    if (event.event === '$exposure') continue;
    const key = unitKey(event, unit);
    if (!key) continue;
    if (!eventsByUnit.has(key)) eventsByUnit.set(key, []);
    eventsByUnit.get(key).push(event);
  }

  const arms = {};
  for (const [unitId, exposure] of exposures) {
    const variant = exposure.props.variant;
    arms[variant] ??= { exposed: 0, totals: Object.fromEntries(metrics.map((metric) => [metric.name, { units: 0, sum: 0 }])) };
    arms[variant].exposed += 1;
    const unitEvents = eventsByUnit.get(unitId) ?? [];
    for (const metric of metrics) {
      if (metric.eligible && !metric.eligible(exposure)) continue;
      const total = arms[variant].totals[metric.name];
      total.units += 1;
      total.sum += metricValue(metric, exposure, unitEvents);
    }
  }

  for (const arm of Object.values(arms)) {
    arm.metrics = Object.fromEntries(
      Object.entries(arm.totals).map(([name, { units, sum }]) => [name, { units, value: units > 0 ? sum / units : null }]),
    );
    delete arm.totals;
  }
  return { experiment, overridden, contaminated, arms };
}
