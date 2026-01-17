/**
 * Merchant demo route showcasing the merchant integration perspective.
 * Demonstrates how merchants create payment sessions and view transactions.
 */
import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { Layout } from '../components/Layout';
import api from '../services/api';

/** Route configuration for /merchant */
export const Route = createFileRoute('/merchant')({
  component: MerchantPage,
});

/**
 * Merchant demo page for exploring the merchant API integration.
 * Allows viewing merchant details, creating payment sessions,
 * viewing recent transactions, and exploring available API endpoints.
 * This page demonstrates the merchant-side integration workflow.
 *
 * @returns JSX element representing the merchant demo interface
 */
function MerchantPage() {
  const [merchants, setMerchants] = useState<any[]>([]);
  const [selectedMerchant, setSelectedMerchant] = useState<string | null>(null);
  const [transactions, setTransactions] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [paymentSession, setPaymentSession] = useState<any>(null);
  const [amount, setAmount] = useState('12.99');

  useEffect(() => {
    loadMerchants();
  }, []);

  useEffect(() => {
    if (selectedMerchant) {
      loadMerchantTransactions(selectedMerchant);
    }
  }, [selectedMerchant]);

  const loadMerchants = async () => {
    try {
      const { merchants } = await api.getMerchants();
      setMerchants(merchants);
      if (merchants.length > 0) {
        setSelectedMerchant(merchants[0].id);
      }
    } catch (error) {
      console.error('Failed to load merchants:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const loadMerchantTransactions = async (merchantId: string) => {
    try {
      const response = await fetch(`/api/merchants/${merchantId}/transactions`);
      const data = await response.json();
      setTransactions(data.transactions || []);
    } catch (error) {
      console.error('Failed to load transactions:', error);
    }
  };

  const createPaymentSession = async () => {
    if (!selectedMerchant || !amount) return;

    try {
      const session = await api.createPaymentSession(
        selectedMerchant,
        parseFloat(amount),
        'USD'
      );
      setPaymentSession(session.session);
    } catch (error) {
      console.error('Failed to create session:', error);
    }
  };

  const merchant = merchants.find((m) => m.id === selectedMerchant);

  const formatCurrency = (value: number, currency: string) =>
    new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(value);

  return (
    <Layout title="Merchant Demo">
      <div className="space-y-6">
        {/* Merchant Info */}
        <section className="card">
          <h2 className="text-lg font-semibold text-apple-gray-900 mb-4">
            Merchant Portal
          </h2>

          {isLoading ? (
            <div className="animate-pulse space-y-3">
              <div className="h-4 bg-apple-gray-200 rounded w-1/2" />
              <div className="h-4 bg-apple-gray-200 rounded w-3/4" />
            </div>
          ) : (
            <>
              <select
                value={selectedMerchant || ''}
                onChange={(e) => setSelectedMerchant(e.target.value)}
                className="input mb-4"
              >
                {merchants.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>

              {merchant && (
                <div className="text-sm text-apple-gray-600 space-y-1">
                  <p>
                    <span className="font-medium">Merchant ID:</span>{' '}
                    {merchant.merchant_id}
                  </p>
                  <p>
                    <span className="font-medium">Category Code:</span>{' '}
                    {merchant.category_code}
                  </p>
                  <p>
                    <span className="font-medium">Status:</span>{' '}
                    <span
                      className={
                        merchant.status === 'active'
                          ? 'text-apple-green'
                          : 'text-apple-red'
                      }
                    >
                      {merchant.status}
                    </span>
                  </p>
                </div>
              )}
            </>
          )}
        </section>

        {/* Payment Session (In-App Payment Demo) */}
        <section className="card">
          <h2 className="text-lg font-semibold text-apple-gray-900 mb-4">
            Create Payment Session
          </h2>
          <p className="text-sm text-apple-gray-500 mb-4">
            This simulates what a merchant would do to initiate an Apple Pay
            payment in their app or website.
          </p>

          <div className="flex gap-3 mb-4">
            <div className="flex-1">
              <label className="block text-sm font-medium text-apple-gray-700 mb-1">
                Amount
              </label>
              <div className="flex items-center gap-2">
                <span className="text-apple-gray-400">$</span>
                <input
                  type="number"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  className="input"
                  step="0.01"
                />
              </div>
            </div>
          </div>

          <button onClick={createPaymentSession} className="btn-primary w-full">
            Create Payment Session
          </button>

          {paymentSession && (
            <div className="mt-4 p-4 bg-apple-gray-50 rounded-xl">
              <h3 className="font-medium text-sm mb-2">Session Created:</h3>
              <pre className="text-xs overflow-x-auto text-apple-gray-600">
                {JSON.stringify(paymentSession, null, 2)}
              </pre>
              <p className="text-xs text-apple-gray-500 mt-2">
                In a real app, this session would be used to display the Apple
                Pay sheet to the customer.
              </p>
            </div>
          )}
        </section>

        {/* Recent Transactions */}
        <section className="card">
          <h2 className="text-lg font-semibold text-apple-gray-900 mb-4">
            Recent Transactions
          </h2>

          {transactions.length === 0 ? (
            <p className="text-apple-gray-500 text-sm">
              No transactions yet for this merchant.
            </p>
          ) : (
            <div className="space-y-3">
              {transactions.slice(0, 10).map((tx) => (
                <div
                  key={tx.id}
                  className="flex items-center justify-between py-2 border-b border-apple-gray-100 last:border-0"
                >
                  <div>
                    <div className="text-sm font-medium">
                      {tx.network?.toUpperCase()} ****{tx.last4}
                    </div>
                    <div className="text-xs text-apple-gray-500">
                      {new Date(tx.created_at).toLocaleString()}
                    </div>
                  </div>
                  <div className="text-right">
                    <div
                      className={`font-medium ${
                        tx.status === 'approved'
                          ? 'text-apple-green'
                          : tx.status === 'declined'
                          ? 'text-apple-red'
                          : 'text-apple-gray-600'
                      }`}
                    >
                      {formatCurrency(tx.amount, tx.currency)}
                    </div>
                    <div className="text-xs text-apple-gray-500">
                      {tx.status}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* API Documentation */}
        <section className="card">
          <h2 className="text-lg font-semibold text-apple-gray-900 mb-4">
            Merchant API Endpoints
          </h2>
          <div className="space-y-4 text-sm">
            <div>
              <code className="bg-apple-gray-100 px-2 py-1 rounded text-xs">
                POST /api/merchants/:id/sessions
              </code>
              <p className="text-apple-gray-500 mt-1">
                Create a payment session for checkout
              </p>
            </div>
            <div>
              <code className="bg-apple-gray-100 px-2 py-1 rounded text-xs">
                POST /api/merchants/:id/process
              </code>
              <p className="text-apple-gray-500 mt-1">
                Process a payment with token and cryptogram
              </p>
            </div>
            <div>
              <code className="bg-apple-gray-100 px-2 py-1 rounded text-xs">
                POST /api/merchants/:id/refund
              </code>
              <p className="text-apple-gray-500 mt-1">
                Refund a completed transaction
              </p>
            </div>
            <div>
              <code className="bg-apple-gray-100 px-2 py-1 rounded text-xs">
                GET /api/merchants/:id/transactions
              </code>
              <p className="text-apple-gray-500 mt-1">
                List all transactions for this merchant
              </p>
            </div>
          </div>
        </section>
      </div>
    </Layout>
  );
}
