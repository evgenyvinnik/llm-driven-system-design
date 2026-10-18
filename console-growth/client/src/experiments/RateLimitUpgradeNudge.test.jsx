import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api.js';
import { track } from '../lib/instrumentation.js';
import { renderWithExperiments } from '../test/experimentHarness.jsx';
import RateLimitUpgradeNudge, { RATE_LIMIT_EXPERIMENT, isNudgeEligible, nudgeAmountCents } from './RateLimitUpgradeNudge.jsx';

vi.mock('../api.js', () => ({
  api: { experiments: vi.fn(), logExposure: vi.fn(() => Promise.resolve()) },
}));
vi.mock('../lib/instrumentation.js', () => ({ track: vi.fn() }));

// Northwind Labs as seeded: Tier 1, $25 of Tier 2's $40 bought, 412 429s last week.
function limitsFixture({ nextTier = {}, rateLimit = {} } = {}) {
  return {
    tier: { tier: 1, name: 'Tier 1', rpm: 50 },
    nextTier: {
      tier: 2,
      name: 'Tier 2',
      rpm: 1_000,
      minPurchasedCents: 4_000,
      remainingCents: 1_500,
      waitSatisfied: true,
      eligibleAt: '2026-09-13T10:00:00Z',
      ...nextTier,
    },
    cumulativePurchasedCents: 2_500,
    rateLimit: { rateLimited7d: 412, attempted7d: 11_374, sharePct: 3.6, ...rateLimit },
  };
}

function renderNudge(variant, limits = limitsFixture()) {
  renderWithExperiments(<RateLimitUpgradeNudge limits={limits} />, { variants: { [RATE_LIMIT_EXPERIMENT]: variant }, path: '/usage' });
}

describe('isNudgeEligible', () => {
  it('needs 429s last week and credits left to buy before the next tier', () => {
    expect(isNudgeEligible(limitsFixture())).toBe(true);
    expect(isNudgeEligible(limitsFixture({ rateLimit: { rateLimited7d: 0 } }))).toBe(false);
    expect(isNudgeEligible(limitsFixture({ nextTier: { remainingCents: 0 } }))).toBe(false);
    expect(isNudgeEligible({ ...limitsFixture(), nextTier: null })).toBe(false);
    expect(isNudgeEligible(null)).toBe(false);
  });
});

describe('nudgeAmountCents', () => {
  it('is what is left to buy, but never under the $5 minimum purchase', () => {
    expect(nudgeAmountCents({ remainingCents: 1_500 })).toBe(1_500);
    expect(nudgeAmountCents({ remainingCents: 120 })).toBe(500);
  });
});

describe('RateLimitUpgradeNudge', () => {
  beforeEach(() => vi.clearAllMocks());

  it('logs nothing when the org is not eligible', async () => {
    renderNudge('treatment', limitsFixture({ rateLimit: { rateLimited7d: 0 } }));
    await waitFor(() => expect(api.experiments).toHaveBeenCalled());
    expect(api.logExposure).not.toHaveBeenCalled();
  });

  it('logs the control’s exposure and leaves the Usage page as it is', async () => {
    renderNudge('control');
    await waitFor(() =>
      expect(api.logExposure).toHaveBeenCalledWith(RATE_LIMIT_EXPERIMENT, {
        surface: 'usage_page',
        rate_limited_7d: 412,
        current_tier: 1,
        amount_cents: 1_500,
        wait_satisfied: true,
      }),
    );
    expect(screen.queryByTestId('rate-limit-nudge')).not.toBeInTheDocument();
  });

  it('explains the 429s and the exact purchase that unlocks the next tier', async () => {
    renderNudge('treatment');
    expect(await screen.findByText('412 requests were rate-limited in the last 7 days')).toBeInTheDocument();
    const nudge = screen.getByTestId('rate-limit-nudge');
    expect(nudge).toHaveTextContent('Tier 2 allows 1,000, 20× more');
    expect(nudge).toHaveTextContent('move up right away');
    expect(nudge).toHaveTextContent('$25.00 of $40.00 purchased');
  });

  it('says when the upgrade lands if the waiting period isn’t over', async () => {
    renderNudge('treatment', limitsFixture({ nextTier: { waitSatisfied: false, eligibleAt: '2026-10-21T10:00:00Z' } }));
    expect(await screen.findByTestId('rate-limit-nudge')).toHaveTextContent('move up on Oct 21, 2026');
  });

  it('links to Billing with the amount and source prefilled', async () => {
    renderNudge('treatment');
    await userEvent.click(await screen.findByRole('button', { name: 'Add $15.00 in credits' }));
    expect(screen.getByTestId('location')).toHaveTextContent('/settings/billing?amount=1500&source=rate_limit_nudge');
    expect(track).toHaveBeenCalledWith('rate_limit_nudge_action', {
      experiment: RATE_LIMIT_EXPERIMENT,
      action: 'add_credits',
      rate_limited_7d: 412,
      current_tier: 1,
      amount_cents: 1_500,
      wait_satisfied: true,
    });
  });

  it('links to the tier comparison', async () => {
    renderNudge('treatment');
    await userEvent.click(await screen.findByRole('button', { name: 'Compare tiers' }));
    expect(screen.getByTestId('location')).toHaveTextContent('/limits');
  });
});
