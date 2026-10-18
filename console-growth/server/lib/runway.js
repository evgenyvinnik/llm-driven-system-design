// Credit runway: how long the prepaid balance lasts at the org's recent spend.
//
// The rate is the average over the last 7 complete days. Today is left out because it is only
// partly over, and Workbench runs made just now would otherwise skew it.
import { dailyUsage } from './usage.js';

const DAY_MS = 86_400_000;
export const TRAILING_DAYS = 7;
// Warn this many days before the balance runs out: long enough to act on a weekly cadence.
export const RUNWAY_WARNING_DAYS = 7;

function ceilTo(value, step) {
  return Math.ceil(value / step) * step;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * Auto-reload settings sized to the org's spend: reload when 3 days of credit are left (at
 * least $5), adding about two weeks of spend (between $10 and $500), in $5 steps.
 */
export function suggestAutoReload(avgDailySpendCents) {
  if (avgDailySpendCents <= 0) return { thresholdCents: 500, amountCents: 2_000 };
  return {
    thresholdCents: Math.max(500, ceilTo(avgDailySpendCents * 3, 500)),
    amountCents: clamp(ceilTo(avgDailySpendCents * 14, 500), 1_000, 50_000),
  };
}

export function computeRunway(state, now = new Date()) {
  const yesterday = new Date(now.getTime() - DAY_MS);
  const days = dailyUsage(state, { days: TRAILING_DAYS, now: yesterday });
  const avgDailySpendCents = Math.round((days.reduce((sum, day) => sum + day.costCents, 0) / TRAILING_DAYS) * 100) / 100;

  const { balanceCents, autoReload } = state.billing;
  const depleted = balanceCents <= 0;
  let daysLeft = null;
  if (depleted) daysLeft = 0;
  else if (avgDailySpendCents > 0) daysLeft = Math.round((balanceCents / avgDailySpendCents) * 10) / 10;

  const atRisk =
    state.org.plan === 'build' && !autoReload.enabled && (depleted || (daysLeft !== null && daysLeft <= RUNWAY_WARNING_DAYS));

  return {
    avgDailySpendCents,
    daysLeft,
    runsOutAt: daysLeft === null ? null : new Date(now.getTime() + daysLeft * DAY_MS).toISOString(),
    depleted,
    atRisk,
    suggestedAutoReload: suggestAutoReload(avgDailySpendCents),
  };
}
