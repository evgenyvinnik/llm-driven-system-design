/**
 * Payment route for initiating Apple Pay transactions.
 * Simulates the complete in-app payment flow with biometric authentication.
 */
import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { Layout } from '../components/Layout';
import { CreditCard } from '../components/CreditCard';
import { BiometricModal } from '../components/BiometricModal';
import { useAuthStore, useWalletStore, usePaymentStore, useTransactionStore } from '../stores';
import api from '../services/api';

/** Route configuration for /pay */
export const Route = createFileRoute('/pay')({
  component: PayPage,
});

/**
 * Payment page component for making Apple Pay purchases.
 * Orchestrates the full payment flow: card selection, merchant selection,
 * amount entry, biometric authentication, and payment processing.
 * Includes test scenarios for simulating different payment outcomes.
 *
 * @returns JSX element representing the payment interface
 */
function PayPage() {
  const { devices } = useAuthStore();
  const { cards, loadCards } = useWalletStore();
  const { initiateBiometric, simulateBiometric, processPayment, isProcessing, isAuthenticating } = usePaymentStore();
  const { loadTransactions } = useTransactionStore();

  const [selectedCard, setSelectedCard] = useState<string | null>(null);
  const [amount, setAmount] = useState('');
  const [merchants, setMerchants] = useState<any[]>([]);
  const [selectedMerchant, setSelectedMerchant] = useState<string | null>(null);
  const [showBiometric, setShowBiometric] = useState(false);
  const [biometricSessionId, setBiometricSessionId] = useState<string | null>(null);
  const [result, setResult] = useState<{ success: boolean; message: string } | null>(null);

  useEffect(() => {
    loadCards();
    api.getMerchants().then(({ merchants }) => {
      setMerchants(merchants);
      if (merchants.length > 0) {
        setSelectedMerchant(merchants[0].id);
      }
    });
  }, [loadCards]);

  const activeCards = cards.filter((c) => c.status === 'active');
  const defaultCard = activeCards.find((c) => c.is_default) || activeCards[0];

  useEffect(() => {
    if (defaultCard && !selectedCard) {
      setSelectedCard(defaultCard.id);
    }
  }, [defaultCard, selectedCard]);

  const handlePay = async () => {
    if (!selectedCard || !amount || !selectedMerchant) return;

    const card = cards.find((c) => c.id === selectedCard);
    if (!card) return;

    const device = devices.find((d) => d.id === card.device_id);
    if (!device) return;

    try {
      // Initiate biometric auth
      const sessionId = await initiateBiometric(device.id, 'face_id');
      setBiometricSessionId(sessionId);
      setShowBiometric(true);
    } catch (error) {
      setResult({ success: false, message: (error as Error).message });
    }
  };

  const handleBiometricSuccess = async () => {
    if (!biometricSessionId || !selectedCard || !selectedMerchant) return;

    try {
      // Verify biometric
      await simulateBiometric(biometricSessionId);
      setShowBiometric(false);

      // Process payment
      const paymentResult = await processPayment({
        card_id: selectedCard,
        amount: parseFloat(amount),
        currency: 'USD',
        merchant_id: selectedMerchant,
        transaction_type: 'in_app',
      });

      if (paymentResult.success) {
        setResult({
          success: true,
          message: `Payment of $${amount} approved! Auth: ${paymentResult.auth_code}`,
        });
        setAmount('');
        loadTransactions();
      } else {
        setResult({
          success: false,
          message: paymentResult.error || 'Payment declined',
        });
      }
    } catch (error) {
      setResult({ success: false, message: (error as Error).message });
    }

    setBiometricSessionId(null);
  };

  const card = cards.find((c) => c.id === selectedCard);
  const merchant = merchants.find((m) => m.id === selectedMerchant);

  return (
    <Layout title="Pay">
      {result && (
        <div
          className={`mb-6 p-4 rounded-xl ${
            result.success ? 'bg-apple-green/10 text-apple-green' : 'bg-apple-red/10 text-apple-red'
          }`}
        >
          <div className="flex items-center gap-2">
            {result.success ? (
              <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
                <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z" />
              </svg>
            ) : (
              <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
                <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12 19 6.41z" />
              </svg>
            )}
            <span className="font-medium">{result.message}</span>
          </div>
          <button
            onClick={() => setResult(null)}
            className="text-sm underline mt-2"
          >
            Dismiss
          </button>
        </div>
      )}

      {activeCards.length === 0 ? (
        <div className="text-center py-16 text-apple-gray-500">
          <svg className="w-16 h-16 mx-auto mb-4 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" />
          </svg>
          <p>No active cards</p>
          <p className="text-sm">Add a card to your wallet to make payments</p>
        </div>
      ) : (
        <>
          {/* Selected Card */}
          <section className="mb-6">
            <h2 className="text-sm font-semibold text-apple-gray-500 uppercase tracking-wide mb-3">
              Pay With
            </h2>
            {card && <CreditCard card={card} />}

            {activeCards.length > 1 && (
              <div className="mt-4">
                <select
                  value={selectedCard || ''}
                  onChange={(e) => setSelectedCard(e.target.value)}
                  className="input"
                >
                  {activeCards.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.network.toUpperCase()} ****{c.last4}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </section>

          {/* Merchant Selection */}
          <section className="mb-6">
            <h2 className="text-sm font-semibold text-apple-gray-500 uppercase tracking-wide mb-3">
              Pay To
            </h2>
            <div className="card">
              {merchants.length === 0 ? (
                <p className="text-apple-gray-500">Loading merchants...</p>
              ) : (
                <>
                  <select
                    value={selectedMerchant || ''}
                    onChange={(e) => setSelectedMerchant(e.target.value)}
                    className="input mb-2"
                  >
                    {merchants.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                  </select>
                  {merchant && (
                    <p className="text-sm text-apple-gray-500">
                      Category: {merchant.category_code}
                    </p>
                  )}
                </>
              )}
            </div>
          </section>

          {/* Amount */}
          <section className="mb-6">
            <h2 className="text-sm font-semibold text-apple-gray-500 uppercase tracking-wide mb-3">
              Amount
            </h2>
            <div className="card">
              <div className="flex items-center gap-2">
                <span className="text-2xl text-apple-gray-400">$</span>
                <input
                  type="number"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder="0.00"
                  className="text-3xl font-semibold bg-transparent border-none outline-none w-full"
                  step="0.01"
                  min="0"
                />
              </div>

              {/* Quick amounts */}
              <div className="flex gap-2 mt-4">
                {[5, 10, 25, 50, 100].map((amt) => (
                  <button
                    key={amt}
                    onClick={() => setAmount(amt.toString())}
                    className="flex-1 py-2 bg-apple-gray-100 rounded-lg text-sm font-medium hover:bg-apple-gray-200"
                  >
                    ${amt}
                  </button>
                ))}
              </div>
            </div>
          </section>

          {/* Pay Button */}
          <button
            onClick={handlePay}
            disabled={!amount || parseFloat(amount) <= 0 || !selectedMerchant || isProcessing}
            className="btn-primary w-full text-lg py-4 flex items-center justify-center gap-3"
          >
            <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
              <path d="M18.71 19.5C17.88 20.74 17 21.95 15.66 21.97C14.32 22 13.89 21.18 12.37 21.18C10.84 21.18 10.37 21.95 9.1 22C7.79 22.05 6.8 20.68 5.96 19.47C4.25 17 2.94 12.45 4.7 9.39C5.57 7.87 7.13 6.91 8.82 6.88C10.1 6.86 11.32 7.75 12.11 7.75C12.89 7.75 14.37 6.68 15.92 6.84C16.57 6.87 18.39 7.1 19.56 8.82C19.47 8.88 17.39 10.1 17.41 12.63C17.44 15.65 20.06 16.66 20.09 16.67C20.06 16.74 19.67 18.11 18.71 19.5Z" />
            </svg>
            {isProcessing ? 'Processing...' : 'Pay with Apple Pay'}
          </button>

          {/* Test scenarios hint */}
          <div className="mt-6 p-4 bg-apple-gray-50 rounded-xl text-sm text-apple-gray-600">
            <p className="font-medium mb-2">Test Scenarios:</p>
            <ul className="space-y-1 text-xs">
              <li>Amount $666.66 - Insufficient funds</li>
              <li>Amount $999.99 - Card declined</li>
              <li>Amount over $10,000 - Limit exceeded</li>
            </ul>
          </div>
        </>
      )}

      <BiometricModal
        isOpen={showBiometric}
        authType="face_id"
        onSuccess={handleBiometricSuccess}
        onCancel={() => {
          setShowBiometric(false);
          setBiometricSessionId(null);
        }}
        isLoading={isAuthenticating}
      />
    </Layout>
  );
}
