// Prepaid credits: balance, purchases, auto-reload and usage tiers.
import { TIERS, roundCents } from './catalog.js';
import { track } from './analytics.js';
import { badRequest } from './errors.js';

const DAY_MS = 86_400_000;
export const MIN_PURCHASE_CENTS = 500;
export const MAX_PURCHASE_CENTS = 100_000;

// Where a billing action was started, recorded on purchase and auto-reload events so each one
// can be attributed to the surface that prompted it. Anything else is recorded as 'other'.
export const BILLING_SOURCES = ['billing_page', 'runway_banner', 'rate_limit_nudge'];

export function normalizeSource(source) {
  return BILLING_SOURCES.includes(source) ? source : 'other';
}

export function tierFor(billing, now = new Date()) {
  const daysSinceFirstPurchase = billing.firstPurchaseAt
    ? (now.getTime() - new Date(billing.firstPurchaseAt).getTime()) / DAY_MS
    : 0;
  let reached = TIERS[0];
  for (const tier of TIERS) {
    if (billing.cumulativePurchasedCents >= tier.minPurchasedCents && daysSinceFirstPurchase >= tier.waitDays) {
      reached = tier;
    }
  }
  return reached;
}

// The tier after the current one and what it takes to get there, or null at the top tier.
export function nextTierFor(billing, now = new Date()) {
  const current = tierFor(billing, now);
  const next = TIERS.find((tier) => tier.tier === current.tier + 1);
  if (!next) return null;
  const eligibleAt = billing.firstPurchaseAt
    ? new Date(new Date(billing.firstPurchaseAt).getTime() + next.waitDays * DAY_MS)
    : null;
  return {
    ...next,
    remainingCents: Math.max(0, next.minPurchasedCents - billing.cumulativePurchasedCents),
    eligibleAt: eligibleAt ? eligibleAt.toISOString() : null,
    waitSatisfied: eligibleAt ? eligibleAt <= now : next.waitDays === 0,
  };
}

function assertWholeCents(value, field, { min, max }) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw badRequest(`${field} must be a whole number of cents between ${min} and ${max}.`);
  }
}

function addCredits(state, amountCents, type, { source, context, now }) {
  const { billing } = state;
  const tierBefore = tierFor(billing, now).tier;
  const transaction = {
    id: `txn_${now.getTime().toString(36)}_${billing.transactions.length + 1}`,
    type,
    amountCents,
    createdAt: now.toISOString(),
    status: 'paid',
  };
  billing.transactions.unshift(transaction);
  billing.balanceCents = roundCents(billing.balanceCents + amountCents);
  billing.cumulativePurchasedCents += amountCents;
  billing.firstPurchaseAt ??= now.toISOString();

  const tierAfter = tierFor(billing, now).tier;
  if (tierAfter > tierBefore) {
    track('usage_tier_upgraded', { from_tier: tierBefore, to_tier: tierAfter, via: type, source }, context);
  }
  return { transaction, tierBefore, tierAfter };
}

function chargeAutoReload(state, trigger, context, now) {
  const balanceBeforeCents = state.billing.balanceCents;
  const result = addCredits(state, state.billing.autoReload.amountCents, 'auto_reload', { source: 'auto_reload', context, now });
  track(
    'auto_reload_charged',
    { amount_cents: result.transaction.amountCents, balance_before_cents: balanceBeforeCents, trigger },
    context,
  );
  return result.transaction;
}

/**
 * Take usage cost out of the balance. Auto-reload tops it up as soon as it falls below the
 * threshold. If the balance still crosses $0, that is a depletion: every request now fails.
 * @param cause what spent the credits: 'workbench' or 'api_traffic'
 */
export function debit(state, amountCents, { cause = 'api_traffic', context = {}, now = new Date() } = {}) {
  const { billing } = state;
  const balanceBeforeCents = billing.balanceCents;
  billing.balanceCents = roundCents(billing.balanceCents - amountCents);
  let autoReload = null;
  if (billing.autoReload.enabled && billing.balanceCents < billing.autoReload.thresholdCents) {
    autoReload = chargeAutoReload(state, 'threshold', context, now);
  }
  const depleted = balanceBeforeCents > 0 && billing.balanceCents <= 0;
  if (depleted) {
    track(
      'credit_balance_depleted',
      { balance_before_cents: balanceBeforeCents, cause, auto_reload_enabled: billing.autoReload.enabled },
      context,
    );
  }
  return { balanceCents: billing.balanceCents, autoReload, depleted };
}

export function purchaseCredits(state, amountCents, { source, context = {}, now = new Date() } = {}) {
  assertWholeCents(amountCents, 'amountCents', { min: MIN_PURCHASE_CENTS, max: MAX_PURCHASE_CENTS });
  const balanceBeforeCents = state.billing.balanceCents;
  const normalizedSource = normalizeSource(source);
  const result = addCredits(state, amountCents, 'purchase', { source: normalizedSource, context, now });
  track(
    'credits_purchased',
    {
      amount_cents: amountCents,
      balance_before_cents: balanceBeforeCents,
      source: normalizedSource,
      tier_before: result.tierBefore,
      tier_after: result.tierAfter,
    },
    context,
  );
  return result;
}

export function updateAutoReload(state, settings, { source, context = {}, now = new Date() } = {}) {
  const { billing } = state;
  const enabled = Boolean(settings.enabled);
  const wasEnabled = billing.autoReload.enabled;
  const thresholdCents = settings.thresholdCents ?? billing.autoReload.thresholdCents;
  const amountCents = settings.amountCents ?? billing.autoReload.amountCents;
  assertWholeCents(thresholdCents, 'thresholdCents', { min: MIN_PURCHASE_CENTS, max: MAX_PURCHASE_CENTS });
  assertWholeCents(amountCents, 'amountCents', { min: MIN_PURCHASE_CENTS, max: MAX_PURCHASE_CENTS });

  billing.autoReload = { enabled, thresholdCents, amountCents };
  track(
    'auto_reload_updated',
    {
      enabled,
      was_enabled: wasEnabled,
      threshold_cents: thresholdCents,
      amount_cents: amountCents,
      balance_cents: billing.balanceCents,
      source: normalizeSource(source),
    },
    context,
  );

  // Turning it on while already under the threshold reloads right away; otherwise the next
  // request would be the one to trigger it.
  const charged = enabled && billing.balanceCents < thresholdCents ? chargeAutoReload(state, 'enabled', context, now) : null;
  return { autoReload: billing.autoReload, charged };
}
