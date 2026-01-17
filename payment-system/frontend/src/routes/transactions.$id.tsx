import { createFileRoute, Navigate, useNavigate } from '@tanstack/react-router';
import { useAuthStore } from '../../stores/authStore';
import { useEffect, useState } from 'react';
import { getPayment, capturePayment, voidPayment, refundPayment } from '../../services/api';
import type { Transaction } from '../../types';
import { formatCurrency, formatDate, getStatusColor } from '../../utils/format';

function TransactionDetail() {
  const { id } = Route.useParams();
  const navigate = useNavigate();
  const { isAuthenticated } = useAuthStore();
  const [transaction, setTransaction] = useState<Transaction | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refundAmount, setRefundAmount] = useState('');
  const [refundReason, setRefundReason] = useState('');
  const [showRefundForm, setShowRefundForm] = useState(false);

  useEffect(() => {
    async function loadData() {
      try {
        setLoading(true);
        const tx = await getPayment(id);
        setTransaction(tx);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load transaction');
      } finally {
        setLoading(false);
      }
    }

    if (isAuthenticated) {
      loadData();
    }
  }, [isAuthenticated, id]);

  if (!isAuthenticated) {
    return <Navigate to="/login" />;
  }

  async function handleCapture() {
    setActionLoading(true);
    try {
      const updated = await capturePayment(id);
      setTransaction(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to capture payment');
    } finally {
      setActionLoading(false);
    }
  }

  async function handleVoid() {
    setActionLoading(true);
    try {
      const updated = await voidPayment(id);
      setTransaction(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to void payment');
    } finally {
      setActionLoading(false);
    }
  }

  async function handleRefund() {
    setActionLoading(true);
    try {
      const amount = refundAmount ? parseInt(refundAmount) * 100 : undefined;
      await refundPayment(id, amount, refundReason || undefined);
      const updated = await getPayment(id);
      setTransaction(updated);
      setShowRefundForm(false);
      setRefundAmount('');
      setRefundReason('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to refund payment');
    } finally {
      setActionLoading(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary-600"></div>
      </div>
    );
  }

  if (error && !transaction) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700">
        {error}
      </div>
    );
  }

  if (!transaction) {
    return null;
  }

  const canCapture = transaction.status === 'authorized';
  const canVoid = transaction.status === 'authorized';
  const canRefund =
    transaction.status === 'captured' ||
    transaction.status === 'partially_refunded';

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <button
            onClick={() => navigate({ to: '/transactions' })}
            className="text-sm text-gray-500 hover:text-gray-700 mb-2"
          >
            &larr; Back to Transactions
          </button>
          <h2 className="text-2xl font-bold leading-7 text-gray-900">
            Transaction Details
          </h2>
        </div>
        <span
          className={`inline-flex px-3 py-1 text-sm font-semibold rounded-full ${getStatusColor(transaction.status)}`}
        >
          {transaction.status}
        </span>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700">
          {error}
        </div>
      )}

      <div className="bg-white shadow overflow-hidden sm:rounded-lg">
        <div className="px-4 py-5 sm:px-6">
          <h3 className="text-lg leading-6 font-medium text-gray-900">
            Payment Information
          </h3>
        </div>
        <div className="border-t border-gray-200 px-4 py-5 sm:px-6">
          <dl className="grid grid-cols-1 gap-x-4 gap-y-6 sm:grid-cols-2">
            <div>
              <dt className="text-sm font-medium text-gray-500">
                Transaction ID
              </dt>
              <dd className="mt-1 text-sm text-gray-900 font-mono">
                {transaction.id}
              </dd>
            </div>
            <div>
              <dt className="text-sm font-medium text-gray-500">Amount</dt>
              <dd className="mt-1 text-sm text-gray-900">
                {formatCurrency(transaction.amount, transaction.currency)}
              </dd>
            </div>
            <div>
              <dt className="text-sm font-medium text-gray-500">
                Platform Fee
              </dt>
              <dd className="mt-1 text-sm text-gray-900">
                {formatCurrency(transaction.fee_amount, transaction.currency)}
              </dd>
            </div>
            <div>
              <dt className="text-sm font-medium text-gray-500">Net Amount</dt>
              <dd className="mt-1 text-sm text-gray-900">
                {formatCurrency(transaction.net_amount, transaction.currency)}
              </dd>
            </div>
            <div>
              <dt className="text-sm font-medium text-gray-500">
                Payment Method
              </dt>
              <dd className="mt-1 text-sm text-gray-900">
                {transaction.payment_method.card_brand} ****
                {transaction.payment_method.last_four}
                {transaction.payment_method.exp_month &&
                  transaction.payment_method.exp_year && (
                    <span className="text-gray-500 ml-2">
                      Exp: {transaction.payment_method.exp_month}/
                      {transaction.payment_method.exp_year}
                    </span>
                  )}
              </dd>
            </div>
            <div>
              <dt className="text-sm font-medium text-gray-500">
                Customer Email
              </dt>
              <dd className="mt-1 text-sm text-gray-900">
                {transaction.customer_email || 'N/A'}
              </dd>
            </div>
            <div>
              <dt className="text-sm font-medium text-gray-500">Description</dt>
              <dd className="mt-1 text-sm text-gray-900">
                {transaction.description || 'N/A'}
              </dd>
            </div>
            <div>
              <dt className="text-sm font-medium text-gray-500">Risk Score</dt>
              <dd className="mt-1 text-sm text-gray-900">
                {transaction.risk_score ?? 'N/A'}
              </dd>
            </div>
            <div>
              <dt className="text-sm font-medium text-gray-500">Created</dt>
              <dd className="mt-1 text-sm text-gray-900">
                {formatDate(transaction.created_at)}
              </dd>
            </div>
            {transaction.captured_at && (
              <div>
                <dt className="text-sm font-medium text-gray-500">Captured</dt>
                <dd className="mt-1 text-sm text-gray-900">
                  {formatDate(transaction.captured_at)}
                </dd>
              </div>
            )}
            {transaction.idempotency_key && (
              <div className="sm:col-span-2">
                <dt className="text-sm font-medium text-gray-500">
                  Idempotency Key
                </dt>
                <dd className="mt-1 text-sm text-gray-900 font-mono">
                  {transaction.idempotency_key}
                </dd>
              </div>
            )}
          </dl>
        </div>
      </div>

      {/* Actions */}
      {(canCapture || canVoid || canRefund) && (
        <div className="bg-white shadow sm:rounded-lg">
          <div className="px-4 py-5 sm:px-6">
            <h3 className="text-lg leading-6 font-medium text-gray-900">
              Actions
            </h3>
          </div>
          <div className="border-t border-gray-200 px-4 py-5 sm:px-6 space-y-4">
            <div className="flex space-x-4">
              {canCapture && (
                <button
                  onClick={handleCapture}
                  disabled={actionLoading}
                  className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-green-600 hover:bg-green-700 disabled:opacity-50"
                >
                  {actionLoading ? 'Processing...' : 'Capture Payment'}
                </button>
              )}
              {canVoid && (
                <button
                  onClick={handleVoid}
                  disabled={actionLoading}
                  className="inline-flex items-center px-4 py-2 border border-gray-300 text-sm font-medium rounded-md shadow-sm text-gray-700 bg-white hover:bg-gray-50 disabled:opacity-50"
                >
                  {actionLoading ? 'Processing...' : 'Void Payment'}
                </button>
              )}
              {canRefund && !showRefundForm && (
                <button
                  onClick={() => setShowRefundForm(true)}
                  className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-purple-600 hover:bg-purple-700"
                >
                  Refund Payment
                </button>
              )}
            </div>

            {showRefundForm && (
              <div className="mt-4 p-4 bg-gray-50 rounded-lg">
                <h4 className="text-sm font-medium text-gray-900 mb-4">
                  Refund Payment
                </h4>
                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700">
                      Amount (leave empty for full refund)
                    </label>
                    <div className="mt-1 relative rounded-md shadow-sm">
                      <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                        <span className="text-gray-500 sm:text-sm">$</span>
                      </div>
                      <input
                        type="number"
                        value={refundAmount}
                        onChange={(e) => setRefundAmount(e.target.value)}
                        className="block w-full pl-7 pr-12 py-2 border-gray-300 rounded-md focus:ring-primary-500 focus:border-primary-500 sm:text-sm"
                        placeholder={String(transaction.amount / 100)}
                      />
                    </div>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700">
                      Reason (optional)
                    </label>
                    <input
                      type="text"
                      value={refundReason}
                      onChange={(e) => setRefundReason(e.target.value)}
                      className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500 sm:text-sm"
                      placeholder="Customer requested refund"
                    />
                  </div>
                  <div className="flex space-x-3">
                    <button
                      onClick={handleRefund}
                      disabled={actionLoading}
                      className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-purple-600 hover:bg-purple-700 disabled:opacity-50"
                    >
                      {actionLoading ? 'Processing...' : 'Submit Refund'}
                    </button>
                    <button
                      onClick={() => setShowRefundForm(false)}
                      className="inline-flex items-center px-4 py-2 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export const Route = createFileRoute('/transactions/$id')({
  component: TransactionDetail,
});
