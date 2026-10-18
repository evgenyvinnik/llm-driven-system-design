import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../../api.js';
import { useAppData } from '../../lib/appData.jsx';
import { toast } from '../../lib/toast.js';
import { formatCents, formatDate } from '../../lib/format.js';

const PRESETS_CENTS = [1_000, 2_500, 5_000, 10_000];
const DEFAULT_AMOUNT_CENTS = 2_500;

function dollarsToCents(value) {
  return Math.round(Number(value) * 100);
}

// Links from experiment surfaces prefill the amount (?amount=<cents>) and say where the
// purchase started (?source=), which is recorded on the purchase event.
function requestedAmountCents(searchParams) {
  const cents = Number(searchParams.get('amount'));
  return Number.isInteger(cents) && cents >= 500 && cents <= 100_000 ? cents : DEFAULT_AMOUNT_CENTS;
}

function BuyCredits({ initialAmountCents, source, onPurchased }) {
  const [amount, setAmount] = useState(String(initialAmountCents / 100));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api.buyCredits({ amountCents: dollarsToCents(amount), source });
      // Only the rate-limit nudge promised a tier change, so only its purchases confirm one.
      const upgraded = source === 'rate_limit_nudge' && result.tierAfter > result.tierBefore;
      toast(`Added ${formatCents(result.transaction.amountCents)} to your balance.${upgraded ? ` You’re now on Tier ${result.tierAfter}.` : ''}`);
      onPurchased(result.billing);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit}>
      <div className="row" style={{ marginBottom: 10 }}>
        {PRESETS_CENTS.map((cents) => (
          <button
            key={cents}
            type="button"
            className={`btn btn-sm${dollarsToCents(amount) === cents ? ' selected' : ''}`}
            onClick={() => setAmount(String(cents / 100))}
          >
            {formatCents(cents)}
          </button>
        ))}
      </div>
      <div className="row">
        <div className="input-prefix" style={{ maxWidth: 160 }}>
          $
          <input type="number" aria-label="Amount in dollars" min="5" max="1000" step="1" value={amount} onChange={(event) => setAmount(event.target.value)} />
        </div>
        <button className="btn btn-primary" type="submit" disabled={busy || !(Number(amount) >= 5)}>
          {busy ? 'Processing…' : 'Buy credits'}
        </button>
      </div>
      <div className="field-hint">Minimum $5, maximum $1,000 per purchase. Charged to your card on file.</div>
      {error && <div className="error-text">{error}</div>}
    </form>
  );
}

function AutoReloadSettings({ billing, onSaved }) {
  const [enabled, setEnabled] = useState(billing.autoReload.enabled);
  const [threshold, setThreshold] = useState(String(billing.autoReload.thresholdCents / 100));
  const [amount, setAmount] = useState(String(billing.autoReload.amountCents / 100));
  const [error, setError] = useState(null);

  const save = async (event) => {
    event.preventDefault();
    setError(null);
    try {
      const result = await api.updateAutoReload({
        enabled,
        thresholdCents: dollarsToCents(threshold),
        amountCents: dollarsToCents(amount),
        source: 'billing_page',
      });
      toast(result.charged ? `Auto-reload saved. Added ${formatCents(result.charged.amountCents)} now.` : 'Auto-reload saved.');
      onSaved(result.billing);
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <form onSubmit={save}>
      <label className="switch">
        <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
        Automatically buy credits when my balance runs low
      </label>
      <div className="grid grid-2" style={{ marginTop: 12, maxWidth: 420 }}>
        <div className="field">
          <label htmlFor="threshold">When balance falls below</label>
          <div className="input-prefix">
            $<input id="threshold" type="number" min="5" step="1" value={threshold} onChange={(event) => setThreshold(event.target.value)} />
          </div>
        </div>
        <div className="field">
          <label htmlFor="reload-amount">Add this amount</label>
          <div className="input-prefix">
            $<input id="reload-amount" type="number" min="5" step="1" value={amount} onChange={(event) => setAmount(event.target.value)} />
          </div>
        </div>
      </div>
      {error && <div className="error-text">{error}</div>}
      <button className="btn" type="submit">
        Save
      </button>
    </form>
  );
}

export default function Billing() {
  const { billing, setBilling, refreshBilling } = useAppData();
  const [searchParams, setSearchParams] = useSearchParams();
  const initialAmountCents = requestedAmountCents(searchParams);
  const source = searchParams.get('source') ?? 'billing_page';

  const onPurchased = (nextBilling) => {
    setBilling(nextBilling);
    // Later purchases in this visit weren't prompted by the link, so stop attributing them to it.
    if (searchParams.has('source')) setSearchParams({}, { replace: true });
  };

  useEffect(() => {
    refreshBilling();
  }, [refreshBilling]);

  if (!billing) return <div className="muted">Loading…</div>;
  return (
    <>
      <div className="page-header">
        <h1>Billing</h1>
        <p>Build plan · prepaid credits. API requests draw down your balance; when it reaches $0, requests fail until you add credits.</p>
      </div>
      <div className="grid grid-2">
        <div className="card">
          <div className="stat-label">Credit balance</div>
          <div className="stat-value">{formatCents(billing.balanceCents)}</div>
          <div className="stat-sub">Auto-reload is {billing.autoReload.enabled ? 'on' : 'off'}</div>
        </div>
        <div className="card">
          <div className="stat-label">Payment method</div>
          <div className="stat-value" style={{ fontSize: 18 }}>
            {billing.paymentMethod.brand} •••• {billing.paymentMethod.last4}
          </div>
          <div className="stat-sub">Expires {billing.paymentMethod.expires}</div>
        </div>
      </div>
      <div className="card" style={{ marginTop: 16 }}>
        <h2>Buy credits</h2>
        <BuyCredits key={`${initialAmountCents}:${source}`} initialAmountCents={initialAmountCents} source={source} onPurchased={onPurchased} />
      </div>
      <div className="card">
        <h2>Auto-reload</h2>
        <AutoReloadSettings key={JSON.stringify(billing.autoReload)} billing={billing} onSaved={setBilling} />
      </div>
      <div className="card">
        <h2>History</h2>
        <table className="table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Type</th>
              <th className="num">Amount</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {billing.transactions.map((transaction) => (
              <tr key={transaction.id}>
                <td>{formatDate(transaction.createdAt)}</td>
                <td>{transaction.type === 'auto_reload' ? 'Auto-reload' : 'Credit purchase'}</td>
                <td className="num">{formatCents(transaction.amountCents)}</td>
                <td>
                  <span className="badge badge-success">{transaction.status}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
