import { createFileRoute, Navigate, useNavigate } from '@tanstack/react-router';
import { useAuthStore } from '../stores/authStore';
import { useState } from 'react';
import { createPayment } from '../services/api';
import { formatCurrency } from '../utils/format';

function TestPayment() {
  const { isAuthenticated } = useAuthStore();
  const navigate = useNavigate();
  const [amount, setAmount] = useState('50.00');
  const [currency, setCurrency] = useState('USD');
  const [cardBrand, setCardBrand] = useState('visa');
  const [lastFour, setLastFour] = useState('4242');
  const [expMonth, setExpMonth] = useState('12');
  const [expYear, setExpYear] = useState('2025');
  const [description, setDescription] = useState('Test payment');
  const [customerEmail, setCustomerEmail] = useState('customer@example.com');
  const [capture, setCapture] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    id: string;
    status: string;
    amount: number;
    currency: string;
  } | null>(null);

  if (!isAuthenticated) {
    return <Navigate to="/login" />;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const amountInCents = Math.round(parseFloat(amount) * 100);

      const payment = await createPayment({
        amount: amountInCents,
        currency,
        payment_method: {
          type: 'card',
          card_brand: cardBrand,
          last_four: lastFour,
          exp_month: parseInt(expMonth),
          exp_year: parseInt(expYear),
        },
        description,
        customer_email: customerEmail,
        capture,
      });

      setResult({
        id: payment.id,
        status: payment.status,
        amount: payment.amount,
        currency: payment.currency,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create payment');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div>
        <h2 className="text-2xl font-bold leading-7 text-gray-900">
          Test Payment
        </h2>
        <p className="mt-1 text-sm text-gray-500">
          Create a test payment to verify the system is working correctly.
        </p>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700">
          {error}
        </div>
      )}

      {result && (
        <div className="bg-green-50 border border-green-200 rounded-lg p-4">
          <h3 className="text-green-800 font-semibold mb-2">
            Payment Created Successfully!
          </h3>
          <dl className="space-y-1 text-sm">
            <div className="flex">
              <dt className="text-green-700 w-24">ID:</dt>
              <dd className="text-green-900 font-mono">{result.id}</dd>
            </div>
            <div className="flex">
              <dt className="text-green-700 w-24">Status:</dt>
              <dd className="text-green-900">{result.status}</dd>
            </div>
            <div className="flex">
              <dt className="text-green-700 w-24">Amount:</dt>
              <dd className="text-green-900">
                {formatCurrency(result.amount, result.currency)}
              </dd>
            </div>
          </dl>
          <button
            onClick={() => navigate({ to: `/transactions/${result.id}` })}
            className="mt-4 inline-flex items-center px-3 py-2 border border-transparent text-sm font-medium rounded-md text-green-700 bg-green-100 hover:bg-green-200"
          >
            View Transaction Details
          </button>
        </div>
      )}

      <form onSubmit={handleSubmit} className="bg-white shadow sm:rounded-lg">
        <div className="px-4 py-5 sm:p-6 space-y-6">
          {/* Amount */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700">
                Amount
              </label>
              <div className="mt-1 relative rounded-md shadow-sm">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                  <span className="text-gray-500 sm:text-sm">$</span>
                </div>
                <input
                  type="number"
                  step="0.01"
                  min="0.50"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  className="block w-full pl-7 pr-3 py-2 border-gray-300 rounded-md focus:ring-primary-500 focus:border-primary-500 sm:text-sm"
                  required
                />
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700">
                Currency
              </label>
              <select
                value={currency}
                onChange={(e) => setCurrency(e.target.value)}
                className="mt-1 block w-full py-2 px-3 border border-gray-300 bg-white rounded-md shadow-sm focus:outline-none focus:ring-primary-500 focus:border-primary-500 sm:text-sm"
              >
                <option value="USD">USD</option>
                <option value="EUR">EUR</option>
                <option value="GBP">GBP</option>
                <option value="CAD">CAD</option>
              </select>
            </div>
          </div>

          {/* Card Details */}
          <div>
            <h4 className="text-sm font-medium text-gray-700 mb-3">
              Card Details (Test)
            </h4>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-500">
                  Card Brand
                </label>
                <select
                  value={cardBrand}
                  onChange={(e) => setCardBrand(e.target.value)}
                  className="mt-1 block w-full py-2 px-3 border border-gray-300 bg-white rounded-md shadow-sm focus:outline-none focus:ring-primary-500 focus:border-primary-500 sm:text-sm"
                >
                  <option value="visa">Visa</option>
                  <option value="mastercard">Mastercard</option>
                  <option value="amex">American Express</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-500">
                  Last 4 Digits
                </label>
                <input
                  type="text"
                  maxLength={4}
                  value={lastFour}
                  onChange={(e) => setLastFour(e.target.value)}
                  className="mt-1 block w-full py-2 px-3 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-primary-500 focus:border-primary-500 sm:text-sm"
                  placeholder="4242"
                />
                <p className="mt-1 text-xs text-gray-500">
                  Use 0000 to simulate a decline
                </p>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-500">
                  Exp Month
                </label>
                <input
                  type="number"
                  min="1"
                  max="12"
                  value={expMonth}
                  onChange={(e) => setExpMonth(e.target.value)}
                  className="mt-1 block w-full py-2 px-3 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-primary-500 focus:border-primary-500 sm:text-sm"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-500">
                  Exp Year
                </label>
                <input
                  type="number"
                  min="2024"
                  max="2035"
                  value={expYear}
                  onChange={(e) => setExpYear(e.target.value)}
                  className="mt-1 block w-full py-2 px-3 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-primary-500 focus:border-primary-500 sm:text-sm"
                />
              </div>
            </div>
          </div>

          {/* Description & Email */}
          <div className="grid grid-cols-1 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700">
                Description
              </label>
              <input
                type="text"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                className="mt-1 block w-full py-2 px-3 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-primary-500 focus:border-primary-500 sm:text-sm"
                placeholder="Order #12345"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700">
                Customer Email
              </label>
              <input
                type="email"
                value={customerEmail}
                onChange={(e) => setCustomerEmail(e.target.value)}
                className="mt-1 block w-full py-2 px-3 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-primary-500 focus:border-primary-500 sm:text-sm"
                placeholder="customer@example.com"
              />
            </div>
          </div>

          {/* Capture option */}
          <div className="flex items-center">
            <input
              id="capture"
              type="checkbox"
              checked={capture}
              onChange={(e) => setCapture(e.target.checked)}
              className="h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300 rounded"
            />
            <label
              htmlFor="capture"
              className="ml-2 block text-sm text-gray-900"
            >
              Capture immediately (uncheck to authorize only)
            </label>
          </div>
        </div>

        <div className="px-4 py-3 bg-gray-50 text-right sm:px-6">
          <button
            type="submit"
            disabled={loading}
            className="inline-flex justify-center py-2 px-4 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-primary-600 hover:bg-primary-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500 disabled:opacity-50"
          >
            {loading ? 'Processing...' : 'Create Payment'}
          </button>
        </div>
      </form>
    </div>
  );
}

export const Route = createFileRoute('/test-payment')({
  component: TestPayment,
});
