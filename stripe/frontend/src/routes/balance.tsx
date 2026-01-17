import { createFileRoute } from '@tanstack/react-router';
import { useState, useEffect } from 'react';
import { getBalance, getBalanceSummary, listBalanceTransactions } from '@/services/api';
import { formatCurrency, formatDate } from '@/utils';
import { StatusBadge } from '@/components';
import type { Balance, BalanceSummary, BalanceTransaction } from '@/types';

export const Route = createFileRoute('/balance')({
  component: BalancePage,
});

function BalancePage() {
  const [balance, setBalance] = useState<Balance | null>(null);
  const [summary, setSummary] = useState<BalanceSummary | null>(null);
  const [transactions, setTransactions] = useState<BalanceTransaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    loadData();
  }, []);

  async function loadData() {
    try {
      setLoading(true);
      const [balanceData, summaryData, transactionsData] = await Promise.all([
        getBalance(),
        getBalanceSummary(),
        listBalanceTransactions({ limit: 50 }),
      ]);
      setBalance(balanceData);
      setSummary(summaryData);
      setTransactions(transactionsData.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load balance data');
    } finally {
      setLoading(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-stripe-gray-500">Loading...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-50 text-red-700 p-4 rounded-lg">{error}</div>
    );
  }

  const availableBalance = balance?.available[0]?.amount || 0;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-stripe-gray-900">Balance</h1>
        <p className="text-stripe-gray-500 mt-1">Your account balance and transactions</p>
      </div>

      {/* Balance Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="card card-body">
          <div className="text-sm text-stripe-gray-500">Available Balance</div>
          <div className="text-3xl font-bold text-stripe-gray-900 mt-1">
            {formatCurrency(availableBalance)}
          </div>
          <div className="text-xs text-stripe-gray-400 mt-1">USD</div>
        </div>

        <div className="card card-body">
          <div className="text-sm text-stripe-gray-500">Total Fees Paid</div>
          <div className="text-3xl font-bold text-orange-600 mt-1">
            {formatCurrency(summary?.lifetime.total_fees || 0)}
          </div>
          <div className="text-xs text-stripe-gray-400 mt-1">2.9% + 30c per charge</div>
        </div>

        <div className="card card-body">
          <div className="text-sm text-stripe-gray-500">Total Refunded</div>
          <div className="text-3xl font-bold text-blue-600 mt-1">
            {formatCurrency(summary?.lifetime.total_refunded || 0)}
          </div>
          <div className="text-xs text-stripe-gray-400 mt-1">Returned to customers</div>
        </div>
      </div>

      {/* Summary Stats */}
      <div className="card">
        <div className="card-header">
          <h2 className="font-semibold text-stripe-gray-900">Transaction Summary</h2>
        </div>
        <div className="card-body grid grid-cols-2 md:grid-cols-4 gap-6">
          <div>
            <div className="text-sm text-stripe-gray-500">Total Volume</div>
            <div className="text-2xl font-bold text-stripe-gray-900">
              {formatCurrency(summary?.lifetime.total_amount || 0)}
            </div>
          </div>
          <div>
            <div className="text-sm text-stripe-gray-500">Successful Charges</div>
            <div className="text-2xl font-bold text-green-600">
              {summary?.lifetime.successful_charges || 0}
            </div>
          </div>
          <div>
            <div className="text-sm text-stripe-gray-500">Failed Charges</div>
            <div className="text-2xl font-bold text-red-600">
              {summary?.lifetime.failed_charges || 0}
            </div>
          </div>
          <div>
            <div className="text-sm text-stripe-gray-500">Net Revenue</div>
            <div className="text-2xl font-bold text-stripe-purple">
              {formatCurrency(summary?.lifetime.total_net || 0)}
            </div>
          </div>
        </div>
      </div>

      {/* Transaction History */}
      <div className="card">
        <div className="card-header flex items-center justify-between">
          <h2 className="font-semibold text-stripe-gray-900">Balance Transactions</h2>
          <button onClick={loadData} className="btn-secondary btn-sm">
            Refresh
          </button>
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>Type</th>
              <th>Amount</th>
              <th>Description</th>
              <th>Date</th>
            </tr>
          </thead>
          <tbody>
            {transactions.length === 0 ? (
              <tr>
                <td colSpan={4} className="text-center py-8 text-stripe-gray-500">
                  No transactions yet
                </td>
              </tr>
            ) : (
              transactions.map((txn) => (
                <tr key={txn.id}>
                  <td>
                    <span className={`badge ${txn.type === 'refund' ? 'badge-warning' : 'badge-success'}`}>
                      {txn.type}
                    </span>
                  </td>
                  <td className={`font-medium ${txn.amount < 0 ? 'text-red-600' : 'text-green-600'}`}>
                    {txn.amount >= 0 ? '+' : ''}{formatCurrency(txn.amount)}
                  </td>
                  <td className="text-stripe-gray-500">
                    {txn.description || '-'}
                  </td>
                  <td className="text-stripe-gray-500">
                    {formatDate(txn.created)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
