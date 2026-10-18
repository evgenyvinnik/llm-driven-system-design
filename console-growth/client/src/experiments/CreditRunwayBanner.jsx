// Experiment `credit_runway_autoreload` (large bet, EXPERIMENTS.md §2).
//
// Build orgs find out they're out of credits when their production requests start failing.
// Treatment: a banner on every page once the balance will run out within 7 days at the org's
// recent spend (or already has), with one-click auto-reload sized to that spend.
//
// Exposure is logged by <RunwayBanner>, which only mounts for at-risk orgs, so both arms are
// exposed at the same moment: the first page view while at risk. The control renders nothing.
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useExperiment } from '../lib/experiments.jsx';
import { track } from '../lib/instrumentation.js';
import { formatCents } from '../lib/format.js';
import AutoReloadModal from './AutoReloadModal.jsx';

export const RUNWAY_EXPERIMENT = 'credit_runway_autoreload';
const DISMISS_KEY = 'console.runwayBannerDismissed';

export function describeDaysLeft(daysLeft) {
  if (daysLeft < 1) return 'less than a day';
  const days = Math.floor(daysLeft);
  return `about ${days} ${days === 1 ? 'day' : 'days'}`;
}

function wasDismissed() {
  try {
    return sessionStorage.getItem(DISMISS_KEY) === '1';
  } catch {
    return false;
  }
}

function RunwayBanner({ billing, onBillingChange }) {
  const { runway } = billing;
  const bannerState = runway.depleted ? 'depleted' : 'warning';
  const { isTreatment } = useExperiment(RUNWAY_EXPERIMENT, {
    exposureProps: { surface: 'app_banner', state: bannerState, days_left: runway.daysLeft, balance_cents: billing.balanceCents },
  });
  const navigate = useNavigate();
  const [dismissed, setDismissed] = useState(wasDismissed);
  const [modalOpen, setModalOpen] = useState(false);

  // A depleted org can't dismiss: its requests are failing right now.
  if (!isTreatment || (dismissed && !runway.depleted)) return null;

  const trackAction = (action) =>
    track('runway_banner_action', {
      experiment: RUNWAY_EXPERIMENT,
      action,
      state: bannerState,
      days_left: runway.daysLeft,
      balance_cents: billing.balanceCents,
    });

  const openAutoReload = () => {
    trackAction('open_auto_reload');
    setModalOpen(true);
  };

  const addCredits = () => {
    trackAction('add_credits');
    navigate(`/settings/billing?amount=${runway.suggestedAutoReload.amountCents}&source=runway_banner`);
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

  const runsOut = runway.runsOutAt ? new Date(runway.runsOutAt).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' }) : null;

  return (
    <>
      <div className={`banner ${runway.depleted ? 'banner-danger' : 'banner-warning'}`} role="alert" data-testid="runway-banner">
        <div className="banner-body">
          {runway.depleted ? (
            <>
              <div className="banner-title">Your credit balance has run out</div>
              <div>
                API requests from all of your keys are failing with <code>credit_balance_too_low</code>. Add credits to resume, and turn on
                auto-reload so it doesn’t happen again.
              </div>
            </>
          ) : (
            <>
              <div className="banner-title">Your credits will run out in {describeDaysLeft(runway.daysLeft)}</div>
              <div>
                At your recent usage of about {formatCents(runway.avgDailySpendCents)} a day, your {formatCents(billing.balanceCents)} balance runs
                out around {runsOut}. When it reaches $0, API requests from all of your keys will fail.
              </div>
            </>
          )}
        </div>
        <div className="banner-actions">
          <button type="button" className="btn btn-primary btn-sm" onClick={openAutoReload}>
            Turn on auto-reload
          </button>
          <button type="button" className="btn btn-sm" onClick={addCredits}>
            Add credits
          </button>
          {!runway.depleted && (
            <button type="button" className="banner-close" aria-label="Dismiss" onClick={dismiss}>
              ×
            </button>
          )}
        </div>
      </div>
      {modalOpen && (
        <AutoReloadModal
          billing={billing}
          onCancel={() => {
            trackAction('cancel_auto_reload');
            setModalOpen(false);
          }}
          onEnabled={(nextBilling) => {
            setModalOpen(false);
            onBillingChange(nextBilling);
          }}
        />
      )}
    </>
  );
}

/** Rendered by the app layout on every page. Mounts the banner only for at-risk orgs. */
export default function CreditRunwayBanner({ billing, onBillingChange }) {
  if (!billing?.runway?.atRisk) return null;
  return <RunwayBanner billing={billing} onBillingChange={onBillingChange} />;
}
