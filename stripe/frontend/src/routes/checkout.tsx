import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { createPaymentIntent, createPaymentMethod, confirmPaymentIntent } from '@/services/api';
import { formatCurrency } from '@/utils';
import { StatusBadge } from '@/components';

export const Route = createFileRoute('/checkout')({
  component: CheckoutPage,
});

function CheckoutPage() {
  const [step, setStep] = useState<'amount' | 'card' | 'result'>('amount');
  const [amount, setAmount] = useState('25.00');
  const [currency, setCurrency] = useState('usd');
  const [description, setDescription] = useState('');
  const [captureMethod, setCaptureMethod] = useState<'automatic' | 'manual'>('automatic');

  // Card details
  const [cardNumber, setCardNumber] = useState('4242 4242 4242 4242');
  const [expMonth, setExpMonth] = useState('12');
  const [expYear, setExpYear] = useState('2027');
  const [cvc, setCvc] = useState('123');

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<{
    paymentIntentId: string;
    status: string;
    amount: number;
    currency: string;
    declineCode?: string;
  } | null>(null);

  async function handlePayment(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      const amountInCents = Math.round(parseFloat(amount) * 100);

      // Step 1: Create payment intent
      const paymentIntent = await createPaymentIntent({
        amount: amountInCents,
        currency,
        description: description || undefined,
        capture_method: captureMethod,
      });

      // Step 2: Create payment method
      const paymentMethod = await createPaymentMethod({
        type: 'card',
        card: {
          number: cardNumber.replace(/\s/g, ''),
          exp_month: parseInt(expMonth),
          exp_year: parseInt(expYear),
          cvc,
        },
      });

      // Step 3: Confirm payment
      const confirmed = await confirmPaymentIntent(paymentIntent.id, paymentMethod.id);

      setResult({
        paymentIntentId: confirmed.id,
        status: confirmed.status,
        amount: confirmed.amount,
        currency: confirmed.currency,
        declineCode: confirmed.last_payment_error?.decline_code,
      });

      setStep('result');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Payment failed');
    } finally {
      setLoading(false);
    }
  }

  function resetForm() {
    setStep('amount');
    setResult(null);
    setError('');
    setAmount('25.00');
    setDescription('');
  }

  return (
    <div className="max-w-2xl mx-auto">
      <div className="text-center mb-8">
        <h1 className="text-2xl font-bold text-stripe-gray-900">Checkout Demo</h1>
        <p className="text-stripe-gray-500 mt-1">Test the complete payment flow</p>
      </div>

      {/* Progress Steps */}
      <div className="flex items-center justify-center gap-4 mb-8">
        {['Amount', 'Payment', 'Result'].map((label, i) => {
          const stepNames = ['amount', 'card', 'result'];
          const isActive = stepNames.indexOf(step) >= i;
          const isCurrent = stepNames[i] === step;

          return (
            <div key={label} className="flex items-center gap-2">
              <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium ${
                isActive
                  ? 'bg-stripe-purple text-white'
                  : 'bg-stripe-gray-200 text-stripe-gray-500'
              }`}>
                {i + 1}
              </div>
              <span className={isCurrent ? 'font-medium' : 'text-stripe-gray-500'}>
                {label}
              </span>
              {i < 2 && <div className="w-12 h-0.5 bg-stripe-gray-200" />}
            </div>
          );
        })}
      </div>

      <div className="card">
        <div className="card-body">
          {step === 'amount' && (
            <div className="space-y-6">
              <div>
                <label className="label">Amount</label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    className="input flex-1"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    placeholder="25.00"
                  />
                  <select
                    className="input w-24"
                    value={currency}
                    onChange={(e) => setCurrency(e.target.value)}
                  >
                    <option value="usd">USD</option>
                    <option value="eur">EUR</option>
                    <option value="gbp">GBP</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="label">Description (optional)</label>
                <input
                  type="text"
                  className="input"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Order #123"
                />
              </div>

              <div>
                <label className="label">Capture Method</label>
                <select
                  className="input"
                  value={captureMethod}
                  onChange={(e) => setCaptureMethod(e.target.value as 'automatic' | 'manual')}
                >
                  <option value="automatic">Automatic (charge immediately)</option>
                  <option value="manual">Manual (authorize only)</option>
                </select>
              </div>

              <button
                onClick={() => setStep('card')}
                className="btn-primary w-full"
                disabled={!amount || parseFloat(amount) <= 0}
              >
                Continue to Payment
              </button>
            </div>
          )}

          {step === 'card' && (
            <form onSubmit={handlePayment} className="space-y-6">
              <div className="bg-stripe-gray-50 p-4 rounded-lg mb-4">
                <div className="text-sm text-stripe-gray-500">Amount to pay</div>
                <div className="text-2xl font-bold">
                  {formatCurrency(Math.round(parseFloat(amount) * 100), currency)}
                </div>
              </div>

              <div>
                <label className="label">Card Number</label>
                <input
                  type="text"
                  className="input font-mono"
                  value={cardNumber}
                  onChange={(e) => setCardNumber(e.target.value)}
                  placeholder="4242 4242 4242 4242"
                  maxLength={19}
                />
              </div>

              <div className="grid grid-cols-3 gap-4">
                <div>
                  <label className="label">Month</label>
                  <select
                    className="input"
                    value={expMonth}
                    onChange={(e) => setExpMonth(e.target.value)}
                  >
                    {Array.from({ length: 12 }, (_, i) => (
                      <option key={i} value={String(i + 1).padStart(2, '0')}>
                        {String(i + 1).padStart(2, '0')}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="label">Year</label>
                  <select
                    className="input"
                    value={expYear}
                    onChange={(e) => setExpYear(e.target.value)}
                  >
                    {Array.from({ length: 10 }, (_, i) => (
                      <option key={i} value={2024 + i}>
                        {2024 + i}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="label">CVC</label>
                  <input
                    type="text"
                    className="input font-mono"
                    value={cvc}
                    onChange={(e) => setCvc(e.target.value)}
                    placeholder="123"
                    maxLength={4}
                  />
                </div>
              </div>

              {error && (
                <div className="bg-red-50 text-red-700 p-4 rounded-lg">
                  {error}
                </div>
              )}

              <div className="bg-blue-50 p-4 rounded-lg">
                <div className="text-sm font-medium text-blue-900 mb-2">Test Cards</div>
                <div className="text-xs text-blue-700 space-y-1">
                  <div>4242 4242 4242 4242 - Success</div>
                  <div>4000 0000 0000 0002 - Declined</div>
                  <div>4000 0000 0000 9995 - Insufficient funds</div>
                </div>
              </div>

              <div className="flex gap-4">
                <button
                  type="button"
                  onClick={() => setStep('amount')}
                  className="btn-secondary flex-1"
                >
                  Back
                </button>
                <button
                  type="submit"
                  className="btn-primary flex-1"
                  disabled={loading}
                >
                  {loading ? 'Processing...' : `Pay ${formatCurrency(Math.round(parseFloat(amount) * 100), currency)}`}
                </button>
              </div>
            </form>
          )}

          {step === 'result' && result && (
            <div className="text-center space-y-6">
              {result.status === 'succeeded' ? (
                <>
                  <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto">
                    <svg className="w-8 h-8 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                  </div>
                  <div>
                    <h2 className="text-xl font-bold text-stripe-gray-900">Payment Successful!</h2>
                    <p className="text-stripe-gray-500 mt-1">
                      {formatCurrency(result.amount, result.currency)} has been charged
                    </p>
                  </div>
                </>
              ) : result.status === 'requires_capture' ? (
                <>
                  <div className="w-16 h-16 bg-blue-100 rounded-full flex items-center justify-center mx-auto">
                    <svg className="w-8 h-8 text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                    </svg>
                  </div>
                  <div>
                    <h2 className="text-xl font-bold text-stripe-gray-900">Payment Authorized</h2>
                    <p className="text-stripe-gray-500 mt-1">
                      {formatCurrency(result.amount, result.currency)} has been authorized. Capture in the Payments page.
                    </p>
                  </div>
                </>
              ) : (
                <>
                  <div className="w-16 h-16 bg-red-100 rounded-full flex items-center justify-center mx-auto">
                    <svg className="w-8 h-8 text-red-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </div>
                  <div>
                    <h2 className="text-xl font-bold text-stripe-gray-900">Payment Failed</h2>
                    <p className="text-stripe-gray-500 mt-1">
                      {result.declineCode || 'The payment could not be processed'}
                    </p>
                  </div>
                </>
              )}

              <div className="bg-stripe-gray-50 p-4 rounded-lg text-left">
                <div className="space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-stripe-gray-500">Payment Intent ID</span>
                    <code className="font-mono text-xs">{result.paymentIntentId.slice(0, 20)}...</code>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-stripe-gray-500">Status</span>
                    <StatusBadge status={result.status} />
                  </div>
                  <div className="flex justify-between">
                    <span className="text-stripe-gray-500">Amount</span>
                    <span>{formatCurrency(result.amount, result.currency)}</span>
                  </div>
                </div>
              </div>

              <button onClick={resetForm} className="btn-primary">
                Make Another Payment
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
