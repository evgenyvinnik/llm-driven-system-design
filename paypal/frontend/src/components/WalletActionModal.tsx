import { useEffect, useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { paymentMethodsApi, walletApi } from '../services/api';
import type { PaymentMethod } from '../types';
import { formatCents, newIdempotencyKey, parseDollarsToCents } from '../utils/money';

interface WalletActionModalProps {
  mode: 'deposit' | 'withdraw';
  onClose: () => void;
  onDone: () => void;
}

/** Modal for adding money from, or withdrawing to, one of the user's linked payment methods. */
export function WalletActionModal({ mode, onClose, onDone }: WalletActionModalProps) {
  const [methods, setMethods] = useState<PaymentMethod[] | null>(null);
  const [methodId, setMethodId] = useState('');
  const [amount, setAmount] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  // Same key for retries of this attempt; a new one when the inputs change.
  const idempotencyKey = useRef(newIdempotencyKey());

  const isDeposit = mode === 'deposit';

  useEffect(() => {
    let cancelled = false;
    paymentMethodsApi
      .list()
      .then(({ paymentMethods }) => {
        if (cancelled) return;
        setMethods(paymentMethods);
        const preferred = paymentMethods.find((m) => m.isDefault) ?? paymentMethods[0];
        if (preferred) setMethodId(preferred.id);
      })
      .catch(() => !cancelled && setMethods([]));
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    const amountCents = parseDollarsToCents(amount);
    if (amountCents === null) {
      setError('Please enter a valid amount (up to two decimal places)');
      return;
    }
    setSubmitting(true);
    try {
      const call = isDeposit ? walletApi.deposit : walletApi.withdraw;
      await call(amountCents, methodId, idempotencyKey.current);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    }
    setSubmitting(false);
  };

  const cents = parseDollarsToCents(amount);

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white rounded-xl shadow-xl p-6 w-full max-w-md mx-4">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-lg font-bold text-paypal-text">
            {isDeposit ? 'Add money' : 'Withdraw money'}
          </h2>
          <button onClick={onClose} className="text-paypal-secondary hover:text-paypal-text text-xl">
            x
          </button>
        </div>

        {methods === null ? (
          <div className="py-6 text-center text-paypal-secondary">Loading payment methods...</div>
        ) : methods.length === 0 ? (
          <div className="py-4 text-center text-sm text-paypal-secondary">
            Link a bank account or card first.{' '}
            <Link to="/payment-methods" className="text-paypal-primary hover:underline">
              Add a payment method
            </Link>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            {error && <div className="bg-red-50 text-red-600 px-4 py-2 rounded-lg text-sm">{error}</div>}

            <div>
              <label className="block text-sm font-medium text-paypal-text mb-1">
                {isDeposit ? 'From' : 'To'}
              </label>
              <select
                name="paymentMethodId"
                value={methodId}
                onChange={(e) => {
                  idempotencyKey.current = newIdempotencyKey();
                  setMethodId(e.target.value);
                }}
                className="w-full px-3 py-2 border border-paypal-border rounded-lg focus:outline-none focus:ring-2 focus:ring-paypal-primary bg-white"
              >
                {methods.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                    {m.lastFour ? ` ••${m.lastFour}` : ''}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-paypal-text mb-1">Amount</label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-paypal-secondary">$</span>
                <input
                  type="text"
                  inputMode="decimal"
                  name="amount"
                  value={amount}
                  onChange={(e) => {
                    idempotencyKey.current = newIdempotencyKey();
                    setAmount(e.target.value);
                  }}
                  className="w-full pl-7 pr-3 py-2 border border-paypal-border rounded-lg focus:outline-none focus:ring-2 focus:ring-paypal-primary"
                  placeholder="0.00"
                  required
                />
              </div>
              <p className="text-xs text-paypal-secondary mt-1">Up to $10,000 per {isDeposit ? 'deposit' : 'withdrawal'}.</p>
            </div>

            <div className="flex space-x-3 pt-2">
              <button
                type="button"
                onClick={onClose}
                className="flex-1 py-2 border border-paypal-border text-paypal-text rounded-lg hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={submitting || !cents || !methodId}
                className="flex-1 py-2 bg-paypal-primary text-white rounded-lg hover:bg-paypal-hover disabled:opacity-50"
              >
                {submitting
                  ? 'Processing...'
                  : `${isDeposit ? 'Add' : 'Withdraw'} ${cents ? formatCents(cents) : ''}`.trim()}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
