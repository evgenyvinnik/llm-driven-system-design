import { createFileRoute } from '@tanstack/react-router';
import { useState, useEffect } from 'react';
import { api } from '../services/api';
import { useWalletStore, useAuthStore } from '../stores';
import { Button } from '../components/Button';
import { Input } from '../components/Input';
import { formatCurrency, formatDate } from '../utils';
import type { PaymentMethod, Transfer, Cashout } from '../types';

function WalletPage() {
  const [activeTab, setActiveTab] = useState<'overview' | 'history' | 'methods'>('overview');
  const { balance, paymentMethods, isLoading, loadWallet } = useWalletStore();
  const { checkAuth } = useAuthStore();

  useEffect(() => {
    loadWallet();
  }, [loadWallet]);

  return (
    <div className="max-w-md mx-auto">
      <div className="bg-venmo-blue text-white rounded-lg p-6 mb-6">
        <p className="text-sm opacity-80">Venmo Balance</p>
        <p className="text-3xl font-bold mt-1">
          {isLoading ? '...' : formatCurrency(balance)}
        </p>
      </div>

      <div className="flex gap-2 mb-6 overflow-x-auto">
        {(['overview', 'history', 'methods'] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-4 py-2 rounded-full text-sm font-medium whitespace-nowrap transition-colors ${
              activeTab === tab
                ? 'bg-venmo-blue text-white'
                : 'bg-white text-gray-600 hover:bg-gray-50'
            }`}
          >
            {tab === 'methods' ? 'Payment Methods' : tab.charAt(0).toUpperCase() + tab.slice(1)}
          </button>
        ))}
      </div>

      {activeTab === 'overview' && (
        <WalletOverview
          balance={balance}
          paymentMethods={paymentMethods}
          onUpdate={() => { loadWallet(); checkAuth(); }}
        />
      )}
      {activeTab === 'history' && <TransactionHistory />}
      {activeTab === 'methods' && (
        <PaymentMethodsTab methods={paymentMethods} onUpdate={loadWallet} />
      )}
    </div>
  );
}

function WalletOverview({
  balance,
  paymentMethods,
  onUpdate,
}: {
  balance: number;
  paymentMethods: PaymentMethod[];
  onUpdate: () => void;
}) {
  const [showDeposit, setShowDeposit] = useState(false);
  const [showCashout, setShowCashout] = useState(false);
  const [depositAmount, setDepositAmount] = useState('');
  const [cashoutAmount, setCashoutAmount] = useState('');
  const [cashoutSpeed, setCashoutSpeed] = useState<'standard' | 'instant'>('standard');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [cashouts, setCashouts] = useState<Cashout[]>([]);

  useEffect(() => {
    api.getCashouts().then(setCashouts).catch(() => {});
  }, []);

  const handleDeposit = async () => {
    const amount = parseFloat(depositAmount);
    if (isNaN(amount) || amount <= 0) {
      setError('Please enter a valid amount');
      return;
    }

    setLoading(true);
    setError('');

    try {
      await api.deposit(amount);
      onUpdate();
      setShowDeposit(false);
      setDepositAmount('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Deposit failed');
    } finally {
      setLoading(false);
    }
  };

  const handleCashout = async () => {
    const amount = parseFloat(cashoutAmount);
    if (isNaN(amount) || amount <= 0) {
      setError('Please enter a valid amount');
      return;
    }

    if (amount * 100 > balance) {
      setError('Insufficient balance');
      return;
    }

    setLoading(true);
    setError('');

    try {
      await api.cashout({ amount, speed: cashoutSpeed });
      onUpdate();
      setShowCashout(false);
      setCashoutAmount('');
      api.getCashouts().then(setCashouts).catch(() => {});
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Cashout failed');
    } finally {
      setLoading(false);
    }
  };

  const hasBankAccount = paymentMethods.some(m => m.type === 'bank');

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-lg shadow-sm p-4">
        <h3 className="font-medium mb-4">Quick Actions</h3>
        <div className="flex gap-3">
          <Button
            onClick={() => { setShowDeposit(true); setShowCashout(false); }}
            variant="secondary"
            className="flex-1"
          >
            Add Money
          </Button>
          <Button
            onClick={() => { setShowCashout(true); setShowDeposit(false); }}
            variant="secondary"
            className="flex-1"
            disabled={!hasBankAccount || balance === 0}
          >
            Cash Out
          </Button>
        </div>

        {showDeposit && (
          <div className="mt-4 p-4 bg-gray-50 rounded-lg">
            <h4 className="font-medium mb-3">Add Money (Demo)</h4>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500">$</span>
                <input
                  type="number"
                  step="0.01"
                  min="0.01"
                  value={depositAmount}
                  onChange={(e) => setDepositAmount(e.target.value)}
                  placeholder="0.00"
                  className="w-full pl-7 pr-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-venmo-blue"
                />
              </div>
              <Button onClick={handleDeposit} loading={loading}>Add</Button>
            </div>
            {error && <p className="text-red-500 text-sm mt-2">{error}</p>}
            <p className="text-xs text-gray-500 mt-2">This is a simulated deposit for demo purposes.</p>
          </div>
        )}

        {showCashout && (
          <div className="mt-4 p-4 bg-gray-50 rounded-lg">
            <h4 className="font-medium mb-3">Cash Out</h4>
            <div className="space-y-3">
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500">$</span>
                <input
                  type="number"
                  step="0.01"
                  min="0.01"
                  max={(balance / 100).toFixed(2)}
                  value={cashoutAmount}
                  onChange={(e) => setCashoutAmount(e.target.value)}
                  placeholder="0.00"
                  className="w-full pl-7 pr-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-venmo-blue"
                />
              </div>

              <div className="flex gap-2">
                <button
                  onClick={() => setCashoutSpeed('standard')}
                  className={`flex-1 p-3 rounded-lg border text-left ${
                    cashoutSpeed === 'standard' ? 'border-venmo-blue bg-blue-50' : 'border-gray-200'
                  }`}
                >
                  <p className="font-medium">Standard</p>
                  <p className="text-sm text-gray-500">1-3 business days</p>
                  <p className="text-sm text-green-600">Free</p>
                </button>
                <button
                  onClick={() => setCashoutSpeed('instant')}
                  className={`flex-1 p-3 rounded-lg border text-left ${
                    cashoutSpeed === 'instant' ? 'border-venmo-blue bg-blue-50' : 'border-gray-200'
                  }`}
                >
                  <p className="font-medium">Instant</p>
                  <p className="text-sm text-gray-500">In minutes</p>
                  <p className="text-sm text-gray-600">1.5% fee (max $15)</p>
                </button>
              </div>

              <Button onClick={handleCashout} loading={loading} className="w-full">
                Cash Out {cashoutAmount ? formatCurrency(parseFloat(cashoutAmount) * 100) : ''}
              </Button>
            </div>
            {error && <p className="text-red-500 text-sm mt-2">{error}</p>}
          </div>
        )}
      </div>

      {cashouts.length > 0 && (
        <div className="bg-white rounded-lg shadow-sm p-4">
          <h3 className="font-medium mb-3">Recent Cashouts</h3>
          <div className="space-y-3">
            {cashouts.slice(0, 5).map((cashout) => (
              <div key={cashout.id} className="flex justify-between items-center py-2 border-b last:border-0">
                <div>
                  <p className="font-medium">{formatCurrency(cashout.amount)}</p>
                  <p className="text-sm text-gray-500">
                    {cashout.speed === 'instant' ? 'Instant' : 'Standard'} - {formatDate(cashout.created_at)}
                  </p>
                </div>
                <span className={`text-xs px-2 py-1 rounded-full ${
                  cashout.status === 'completed' ? 'bg-green-100 text-green-700' :
                  cashout.status === 'processing' ? 'bg-yellow-100 text-yellow-700' :
                  'bg-gray-100 text-gray-700'
                }`}>
                  {cashout.status}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function TransactionHistory() {
  const [transactions, setTransactions] = useState<Transfer[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const { user } = useAuthStore();

  useEffect(() => {
    api.getTransactionHistory()
      .then(setTransactions)
      .catch(() => {})
      .finally(() => setIsLoading(false));
  }, []);

  if (isLoading) {
    return <div className="text-center py-8"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-venmo-blue mx-auto"></div></div>;
  }

  return (
    <div className="bg-white rounded-lg shadow-sm">
      {transactions.length === 0 ? (
        <div className="p-8 text-center">
          <p className="text-gray-500">No transactions yet</p>
        </div>
      ) : (
        <div className="divide-y">
          {transactions.map((tx) => {
            const isSent = tx.sender_id === user?.id;
            return (
              <div key={tx.id} className="p-4 flex items-center gap-3">
                <div className={`w-10 h-10 rounded-full flex items-center justify-center ${
                  isSent ? 'bg-red-100 text-red-600' : 'bg-green-100 text-green-600'
                }`}>
                  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-5 h-5">
                    <path strokeLinecap="round" strokeLinejoin="round" d={isSent ? 'M4.5 19.5l15-15m0 0H8.25m11.25 0v11.25' : 'M19.5 4.5l-15 15m0 0h11.25m-11.25 0V8.25'} />
                  </svg>
                </div>
                <div className="flex-1">
                  <p className="font-medium">
                    {isSent ? tx.receiver_name : tx.sender_name}
                  </p>
                  <p className="text-sm text-gray-500">{tx.note || 'No note'}</p>
                  <p className="text-xs text-gray-400">{formatDate(tx.created_at)}</p>
                </div>
                <p className={`font-semibold ${isSent ? 'text-red-600' : 'text-green-600'}`}>
                  {isSent ? '-' : '+'}{formatCurrency(tx.amount)}
                </p>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function PaymentMethodsTab({ methods, onUpdate }: { methods: PaymentMethod[]; onUpdate: () => void }) {
  const [showAddBank, setShowAddBank] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [formData, setFormData] = useState({
    bankName: '',
    accountType: 'Checking',
    routingNumber: '',
    accountNumber: '',
  });

  const handleAddBank = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      await api.addBankAccount(formData);
      onUpdate();
      setShowAddBank(false);
      setFormData({ bankName: '', accountType: 'Checking', routingNumber: '', accountNumber: '' });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add bank');
    } finally {
      setLoading(false);
    }
  };

  const handleSetDefault = async (id: string) => {
    try {
      await api.setDefaultPaymentMethod(id);
      onUpdate();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to set default');
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Remove this payment method?')) return;
    try {
      await api.deletePaymentMethod(id);
      onUpdate();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to delete');
    }
  };

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-lg shadow-sm">
        {methods.length === 0 ? (
          <div className="p-8 text-center">
            <p className="text-gray-500 mb-4">No payment methods linked</p>
          </div>
        ) : (
          <div className="divide-y">
            {methods.map((method) => (
              <div key={method.id} className="p-4 flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-gray-100 flex items-center justify-center">
                  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5 text-gray-600">
                    <path strokeLinecap="round" strokeLinejoin="round" d={method.type === 'bank' ? 'M12 21v-8.25M15.75 21v-8.25M8.25 21v-8.25M3 9l9-6 9 6m-1.5 12V10.332A48.36 48.36 0 0012 9.75c-2.551 0-5.056.2-7.5.582V21M3 21h18M12 6.75h.008v.008H12V6.75z' : 'M2.25 8.25h19.5M2.25 9h19.5m-16.5 5.25h6m-6 2.25h3m-3.75 3h15a2.25 2.25 0 002.25-2.25V6.75A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25v10.5A2.25 2.25 0 004.5 19.5z'} />
                  </svg>
                </div>
                <div className="flex-1">
                  <p className="font-medium">{method.name}</p>
                  <p className="text-sm text-gray-500">
                    {method.type === 'bank' ? method.bank_name : 'Card'} - ...{method.last4}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {method.is_default ? (
                    <span className="text-xs bg-venmo-blue text-white px-2 py-1 rounded-full">Default</span>
                  ) : (
                    <button
                      onClick={() => handleSetDefault(method.id)}
                      className="text-xs text-venmo-blue hover:underline"
                    >
                      Set default
                    </button>
                  )}
                  <button
                    onClick={() => handleDelete(method.id)}
                    className="text-gray-400 hover:text-red-500"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <Button onClick={() => setShowAddBank(!showAddBank)} variant="secondary" className="w-full">
        {showAddBank ? 'Cancel' : 'Add Bank Account'}
      </Button>

      {showAddBank && (
        <form onSubmit={handleAddBank} className="bg-white rounded-lg shadow-sm p-4 space-y-4">
          <h3 className="font-medium">Add Bank Account (Simulated)</h3>

          <Input
            label="Bank Name"
            value={formData.bankName}
            onChange={(e) => setFormData({ ...formData, bankName: e.target.value })}
            placeholder="e.g., Chase, Bank of America"
            required
          />

          <Input
            label="Routing Number"
            value={formData.routingNumber}
            onChange={(e) => setFormData({ ...formData, routingNumber: e.target.value })}
            placeholder="9 digits"
            maxLength={9}
            required
          />

          <Input
            label="Account Number"
            value={formData.accountNumber}
            onChange={(e) => setFormData({ ...formData, accountNumber: e.target.value })}
            placeholder="Account number"
            required
          />

          {error && <p className="text-red-500 text-sm">{error}</p>}

          <Button type="submit" loading={loading} className="w-full">
            Link Bank Account
          </Button>

          <p className="text-xs text-gray-500 text-center">
            This is a simulated bank link for demo purposes.
          </p>
        </form>
      )}
    </div>
  );
}

export const Route = createFileRoute('/wallet')({
  component: WalletPage,
});
