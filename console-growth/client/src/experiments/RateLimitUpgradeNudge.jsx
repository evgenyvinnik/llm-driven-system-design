// Experiment `rate_limit_upgrade_nudge` (small bet, EXPERIMENTS.md §3).
//
// The Usage page shows how many requests got a 429 but not what to do about it, though most
// rate-limited orgs are a small purchase away from a tier with 20× the limit. Treatment: explain
// the 429s and offer that exact purchase, linking to Billing with the amount prefilled.
//
// Exposure is logged by <Nudge>, which only mounts for eligible orgs (429s in the last 7 days
// and credits left to buy before the next tier), in both arms. The control renders nothing.
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useExperiment } from '../lib/experiments.jsx';
import { track } from '../lib/instrumentation.js';
import { formatCents, formatDate, formatNumber } from '../lib/format.js';

export const RATE_LIMIT_EXPERIMENT = 'rate_limit_upgrade_nudge';
const MIN_PURCHASE_CENTS = 500;
const DISMISS_KEY = 'console.rateLimitNudgeDismissed';

export function isNudgeEligible(limits) {
  return Boolean(limits?.rateLimit?.rateLimited7d > 0 && limits.nextTier && limits.nextTier.remainingCents > 0);
}

// What to buy to reach the next tier. Purchases have a $5 minimum.
export function nudgeAmountCents(nextTier) {
  return Math.max(nextTier.remainingCents, MIN_PURCHASE_CENTS);
}

function wasDismissed() {
  try {
    return sessionStorage.getItem(DISMISS_KEY) === '1';
  } catch {
    return false;
  }
}

function Nudge({ limits }) {
  const { tier, nextTier, rateLimit, cumulativePurchasedCents } = limits;
  const amountCents = nudgeAmountCents(nextTier);
  const eventProps = {
    rate_limited_7d: rateLimit.rateLimited7d,
    current_tier: tier.tier,
    amount_cents: amountCents,
    wait_satisfied: nextTier.waitSatisfied,
  };
  const { isTreatment } = useExperiment(RATE_LIMIT_EXPERIMENT, { exposureProps: { surface: 'usage_page', ...eventProps } });
  const navigate = useNavigate();
  const [dismissed, setDismissed] = useState(wasDismissed);

  if (!isTreatment || dismissed) return null;

  const trackAction = (action) => track('rate_limit_nudge_action', { experiment: RATE_LIMIT_EXPERIMENT, action, ...eventProps });

  const addCredits = () => {
    trackAction('add_credits');
    navigate(`/settings/billing?amount=${amountCents}&source=rate_limit_nudge`);
  };

  const viewLimits = () => {
    trackAction('view_limits');
    navigate('/limits');
  };

  const dismiss = () => {
    trackAction('dismiss');
    try {
      sessionStorage.setItem(DISMISS_KEY, '1');
    } catch {
      // Not persisted; hidden until the next page load.
    }
    setDismissed(true);
  };

  const multiple = Math.round(nextTier.rpm / tier.rpm);
  const progressPct = Math.min(100, (cumulativePurchasedCents / nextTier.minPurchasedCents) * 100);

  return (
    <div className="banner banner-info" data-testid="rate-limit-nudge">
      <div className="banner-body">
        <div className="banner-title">{formatNumber(rateLimit.rateLimited7d)} requests were rate-limited in the last 7 days</div>
        <div>
          That’s {rateLimit.sharePct}% of your traffic. {tier.name} allows {formatNumber(tier.rpm)} requests per minute per model;{' '}
          {nextTier.name} allows {formatNumber(nextTier.rpm)}, {multiple}× more.{' '}
          {nextTier.waitSatisfied
            ? `Add ${formatCents(amountCents)} in credits and you move up right away.`
            : `Add ${formatCents(amountCents)} in credits now and you move up on ${formatDate(nextTier.eligibleAt)}, when the waiting period ends.`}{' '}
          The credits go to your balance, so they pay for usage you’d have anyway.
        </div>
        <div className="row" style={{ marginTop: 10, maxWidth: 420 }}>
          <div className="progress" style={{ flex: 1 }}>
            <div className="progress-fill" style={{ width: `${progressPct}%` }} />
          </div>
          <span className="small muted">
            {formatCents(cumulativePurchasedCents)} of {formatCents(nextTier.minPurchasedCents)} purchased
          </span>
        </div>
      </div>
      <div className="banner-actions">
        <button type="button" className="btn btn-primary btn-sm" onClick={addCredits}>
          Add {formatCents(amountCents)} in credits
        </button>
        <button type="button" className="btn btn-sm" onClick={viewLimits}>
          Compare tiers
        </button>
        <button type="button" className="banner-close" aria-label="Dismiss" onClick={dismiss}>
          ×
        </button>
      </div>
    </div>
  );
}

/** Rendered at the top of the Usage page. Mounts the nudge only for eligible orgs. */
export default function RateLimitUpgradeNudge({ limits }) {
  if (!isNudgeEligible(limits)) return null;
  return <Nudge limits={limits} />;
}
