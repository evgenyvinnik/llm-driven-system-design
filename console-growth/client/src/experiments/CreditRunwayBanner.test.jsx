import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api.js';
import { track } from '../lib/instrumentation.js';
import { renderWithExperiments } from '../test/experimentHarness.jsx';
import CreditRunwayBanner, { RUNWAY_EXPERIMENT, describeDaysLeft } from './CreditRunwayBanner.jsx';

vi.mock('../api.js', () => ({
  api: { experiments: vi.fn(), logExposure: vi.fn(() => Promise.resolve()), updateAutoReload: vi.fn() },
}));
vi.mock('../lib/instrumentation.js', () => ({ track: vi.fn() }));
vi.mock('../lib/toast.js', () => ({ toast: vi.fn() }));

// Northwind Labs as seeded: $3.84 left at $1.37/day, auto-reload off.
function billingFixture(runway = {}) {
  return {
    balanceCents: 384,
    paymentMethod: { brand: 'Visa', last4: '4242' },
    autoReload: { enabled: false, thresholdCents: 500, amountCents: 2_000 },
    runway: {
      avgDailySpendCents: 137.14,
      daysLeft: 2.8,
      runsOutAt: '2026-10-19T12:00:00Z',
      depleted: false,
      atRisk: true,
      suggestedAutoReload: { thresholdCents: 500, amountCents: 2_000 },
      ...runway,
    },
  };
}

function renderBanner({ variant, billing = billingFixture(), onBillingChange = vi.fn() }) {
  renderWithExperiments(<CreditRunwayBanner billing={billing} onBillingChange={onBillingChange} />, {
    variants: { [RUNWAY_EXPERIMENT]: variant },
  });
  return { onBillingChange };
}

describe('CreditRunwayBanner', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('exposure', () => {
    it('logs nothing for orgs that are not at risk, in either arm', async () => {
      renderBanner({ variant: 'treatment', billing: billingFixture({ atRisk: false, daysLeft: 21 }) });
      await waitFor(() => expect(api.experiments).toHaveBeenCalled());
      expect(screen.queryByTestId('runway-banner')).not.toBeInTheDocument();
      expect(api.logExposure).not.toHaveBeenCalled();
    });

    it('logs the control’s exposure at the same moment, and shows nothing', async () => {
      renderBanner({ variant: 'control' });
      await waitFor(() =>
        expect(api.logExposure).toHaveBeenCalledWith(RUNWAY_EXPERIMENT, {
          surface: 'app_banner',
          state: 'warning',
          days_left: 2.8,
          balance_cents: 384,
        }),
      );
      expect(screen.queryByTestId('runway-banner')).not.toBeInTheDocument();
    });
  });

  describe('treatment', () => {
    it('warns how long the balance lasts at recent usage', async () => {
      renderBanner({ variant: 'treatment' });
      expect(await screen.findByText('Your credits will run out in about 2 days')).toBeInTheDocument();
      expect(screen.getByTestId('runway-banner')).toHaveTextContent('about $1.37 a day, your $3.84 balance');
      expect(api.logExposure).toHaveBeenCalledTimes(1);
    });

    it('switches to an undismissable alert once the balance has run out', async () => {
      renderBanner({ variant: 'treatment', billing: billingFixture({ depleted: true, daysLeft: 0 }) });
      expect(await screen.findByText('Your credit balance has run out')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Dismiss' })).not.toBeInTheDocument();
    });

    it('turns on auto-reload with suggested settings, tagged with the banner as source', async () => {
      const nextBilling = { ...billingFixture({ atRisk: false }), autoReload: { enabled: true, thresholdCents: 500, amountCents: 2_000 } };
      api.updateAutoReload.mockResolvedValue({ charged: { amountCents: 2_000 }, billing: nextBilling });
      const { onBillingChange } = renderBanner({ variant: 'treatment' });
      const user = userEvent.setup();

      await user.click(await screen.findByRole('button', { name: 'Turn on auto-reload' }));
      const dialog = screen.getByRole('dialog', { name: 'Turn on auto-reload' });
      expect(screen.getByLabelText('When balance falls below')).toHaveValue(5);
      expect(screen.getByLabelText('Add')).toHaveValue(20);
      expect(dialog).toHaveTextContent('so we’ll add $20.00 now');

      await user.click(screen.getAllByRole('button', { name: 'Turn on auto-reload' }).at(-1));
      expect(api.updateAutoReload).toHaveBeenCalledWith({ enabled: true, thresholdCents: 500, amountCents: 2_000, source: 'runway_banner' });
      expect(onBillingChange).toHaveBeenCalledWith(nextBilling);
      expect(track).toHaveBeenCalledWith('runway_banner_action', expect.objectContaining({ action: 'open_auto_reload', state: 'warning' }));
    });

    it('sends “Add credits” to Billing with the amount and source prefilled', async () => {
      renderBanner({ variant: 'treatment' });
      await userEvent.click(await screen.findByRole('button', { name: 'Add credits' }));
      expect(screen.getByTestId('location')).toHaveTextContent('/settings/billing?amount=2000&source=runway_banner');
      expect(track).toHaveBeenCalledWith('runway_banner_action', expect.objectContaining({ action: 'add_credits' }));
    });

    it('can be dismissed for the session', async () => {
      renderBanner({ variant: 'treatment' });
      await userEvent.click(await screen.findByRole('button', { name: 'Dismiss' }));
      expect(screen.queryByTestId('runway-banner')).not.toBeInTheDocument();
      expect(sessionStorage.getItem('console.runwayBannerDismissed')).toBe('1');
      expect(track).toHaveBeenCalledWith('runway_banner_action', expect.objectContaining({ action: 'dismiss' }));
    });
  });
});

describe('describeDaysLeft', () => {
  it.each([
    [0.4, 'less than a day'],
    [1.9, 'about 1 day'],
    [2.8, 'about 2 days'],
    [7, 'about 7 days'],
  ])('%s → %s', (daysLeft, text) => {
    expect(describeDaysLeft(daysLeft)).toBe(text);
  });
});
