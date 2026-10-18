// One-click auto-reload for the runway banner, prefilled with settings sized to the org's spend.
// Saving goes through the same endpoint as the Billing page, tagged source 'runway_banner'.
import { useState } from 'react';
import { api } from '../api.js';
import Modal from '../components/Modal.jsx';
import { formatCents } from '../lib/format.js';
import { toast } from '../lib/toast.js';

function toCents(dollars) {
  return Math.round(Number(dollars) * 100);
}

export default function AutoReloadModal({ billing, onCancel, onEnabled }) {
  const { suggestedAutoReload } = billing.runway;
  const [threshold, setThreshold] = useState(String(suggestedAutoReload.thresholdCents / 100));
  const [amount, setAmount] = useState(String(suggestedAutoReload.amountCents / 100));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const thresholdCents = toCents(threshold);
  const amountCents = toCents(amount);
  const chargesNow = billing.balanceCents < thresholdCents;
  const valid = thresholdCents >= 500 && amountCents >= 500;

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api.updateAutoReload({ enabled: true, thresholdCents, amountCents, source: 'runway_banner' });
      toast(
        result.charged
          ? `Auto-reload is on. We added ${formatCents(result.charged.amountCents)} now.`
          : `Auto-reload is on. We’ll add ${formatCents(amountCents)} whenever your balance drops below ${formatCents(thresholdCents)}.`,
      );
      onEnabled(result.billing);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <Modal title="Turn on auto-reload" onClose={onCancel}>
      <form onSubmit={submit}>
        <p className="muted">Keep your API running: we buy credits automatically before your balance runs out.</p>
        <div className="grid grid-2">
          <div className="field">
            <label htmlFor="ar-threshold">When balance falls below</label>
            <div className="input-prefix">
              $<input id="ar-threshold" type="number" min="5" step="1" value={threshold} onChange={(event) => setThreshold(event.target.value)} />
            </div>
          </div>
          <div className="field">
            <label htmlFor="ar-amount">Add</label>
            <div className="input-prefix">
              $<input id="ar-amount" type="number" min="5" step="1" value={amount} onChange={(event) => setAmount(event.target.value)} />
            </div>
          </div>
        </div>
        <div className="field-hint">
          About two weeks of your recent usage. Charged to {billing.paymentMethod.brand} •••• {billing.paymentMethod.last4}. You can change or turn
          this off any time in Billing.
        </div>
        {valid && chargesNow && (
          <div className="notice" style={{ marginTop: 12 }}>
            Your balance ({formatCents(billing.balanceCents)}) is already below {formatCents(thresholdCents)}, so we’ll add {formatCents(amountCents)}{' '}
            now.
          </div>
        )}
        {error && <div className="error-text">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy || !valid}>
            {busy ? 'Turning on…' : 'Turn on auto-reload'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
