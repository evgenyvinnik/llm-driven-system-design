/**
 * Payments Route
 *
 * Payment management page for viewing and managing payment intents.
 * Provides filtering, detail view, and actions like capture and cancel.
 * Implements a master-detail layout with list on the left and details on the right.
 *
 * @module routes/payments
 */

import { createFileRoute, Link } from '@tanstack/react-router';
import { useState, useEffect } from 'react';
import { listPaymentIntents, getPaymentIntent, cancelPaymentIntent, capturePaymentIntent } from '@/services/api';
import { formatCurrency, formatDate, formatRelativeTime } from '@/utils';
import { StatusBadge } from '@/components';
import type { PaymentIntent } from '@/types';

/**
 * Route definition for the payments page (/payments).
 */
export const Route = createFileRoute('/payments')({
  component: PaymentsPage,
});

/**
 * Payments page component.
 * Lists all payment intents with filtering by status, and shows
 * detailed information with available actions for the selected payment.
 *
 * @returns The payments management page
 */
function PaymentsPage() {
  const [payments, setPayments] = useState<PaymentIntent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<string>('');
  const [selectedPayment, setSelectedPayment] = useState<PaymentIntent | null>(null);

  useEffect(() => {
    loadPayments();
  }, [filter]);

  /**
   * Fetches payment intents from the API with optional status filter.
   */
  async function loadPayments() {
    try {
      setLoading(true);
      const result = await listPaymentIntents({
        limit: 50,
        status: filter || undefined,
      });
      setPayments(result.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load payments');
    } finally {
      setLoading(false);
    }
  }

  /**
   * Cancels a payment intent after user confirmation.
   * @param id - Payment intent ID to cancel
   */
  async function handleCancel(id: string) {
    if (!confirm('Are you sure you want to cancel this payment?')) return;

    try {
      await cancelPaymentIntent(id);
      loadPayments();
      setSelectedPayment(null);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to cancel');
    }
  }

  /**
   * Captures an authorized payment intent.
   * @param id - Payment intent ID to capture
   */
  async function handleCapture(id: string) {
    try {
      await capturePaymentIntent(id);
      loadPayments();
      setSelectedPayment(null);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to capture');
    }
  }

  /**
   * Loads and displays detailed information for a payment intent.
   * @param id - Payment intent ID to show details for
   */
  async function showDetails(id: string) {
    try {
      const pi = await getPaymentIntent(id);
      setSelectedPayment(pi);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to load details');
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-stripe-gray-900">Payments</h1>
          <p className="text-stripe-gray-500 mt-1">Manage payment intents and charges</p>
        </div>
        <Link to="/checkout" className="btn-primary">
          Create Payment
        </Link>
      </div>

      {/* Filters */}
      <div className="flex gap-4 items-center">
        <select
          className="input w-48"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        >
          <option value="">All statuses</option>
          <option value="succeeded">Succeeded</option>
          <option value="requires_payment_method">Requires Payment</option>
          <option value="requires_confirmation">Requires Confirmation</option>
          <option value="requires_capture">Authorized</option>
          <option value="failed">Failed</option>
          <option value="canceled">Canceled</option>
        </select>
        <button onClick={loadPayments} className="btn-secondary">
          Refresh
        </button>
      </div>

      {error && (
        <div className="bg-red-50 text-red-700 p-4 rounded-lg">{error}</div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Payments List */}
        <div className="lg:col-span-2">
          <div className="card">
            <table className="table">
              <thead>
                <tr>
                  <th>Amount</th>
                  <th>Status</th>
                  <th>Created</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr>
                    <td colSpan={4} className="text-center py-8">
                      Loading...
                    </td>
                  </tr>
                ) : payments.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="text-center py-8 text-stripe-gray-500">
                      No payments found
                    </td>
                  </tr>
                ) : (
                  payments.map((pi) => (
                    <tr
                      key={pi.id}
                      className={`cursor-pointer ${selectedPayment?.id === pi.id ? 'bg-stripe-purple/5' : ''}`}
                      onClick={() => showDetails(pi.id)}
                    >
                      <td className="font-medium">
                        {formatCurrency(pi.amount, pi.currency)}
                      </td>
                      <td>
                        <StatusBadge status={pi.status} />
                      </td>
                      <td className="text-stripe-gray-500">
                        {formatRelativeTime(pi.created)}
                      </td>
                      <td>
                        <button className="text-stripe-purple hover:underline text-sm">
                          View
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Detail Panel */}
        <div className="lg:col-span-1">
          {selectedPayment ? (
            <div className="card">
              <div className="card-header">
                <h3 className="font-semibold">Payment Details</h3>
              </div>
              <div className="card-body space-y-4">
                <div>
                  <div className="text-sm text-stripe-gray-500">Amount</div>
                  <div className="text-xl font-bold">
                    {formatCurrency(selectedPayment.amount, selectedPayment.currency)}
                  </div>
                </div>

                <div>
                  <div className="text-sm text-stripe-gray-500">Status</div>
                  <StatusBadge status={selectedPayment.status} />
                </div>

                <div>
                  <div className="text-sm text-stripe-gray-500">Payment Intent ID</div>
                  <code className="text-xs bg-stripe-gray-100 px-2 py-1 rounded break-all">
                    {selectedPayment.id}
                  </code>
                </div>

                <div>
                  <div className="text-sm text-stripe-gray-500">Created</div>
                  <div>{formatDate(selectedPayment.created)}</div>
                </div>

                {selectedPayment.description && (
                  <div>
                    <div className="text-sm text-stripe-gray-500">Description</div>
                    <div>{selectedPayment.description}</div>
                  </div>
                )}

                {selectedPayment.last_payment_error && (
                  <div className="bg-red-50 p-3 rounded-lg">
                    <div className="text-sm font-medium text-red-700">Error</div>
                    <div className="text-sm text-red-600">
                      {selectedPayment.last_payment_error.decline_code}: {selectedPayment.last_payment_error.message}
                    </div>
                  </div>
                )}

                {selectedPayment.risk_assessment && (
                  <div>
                    <div className="text-sm text-stripe-gray-500">Risk Assessment</div>
                    <div className="flex items-center gap-2">
                      <StatusBadge status={selectedPayment.risk_assessment.risk_level} />
                      <span className="text-sm">
                        Score: {(selectedPayment.risk_assessment.risk_score * 100).toFixed(0)}%
                      </span>
                    </div>
                  </div>
                )}

                {/* Actions */}
                <div className="pt-4 space-y-2">
                  {selectedPayment.status === 'requires_capture' && (
                    <button
                      onClick={() => handleCapture(selectedPayment.id)}
                      className="btn-primary w-full"
                    >
                      Capture Payment
                    </button>
                  )}
                  {['requires_payment_method', 'requires_confirmation', 'requires_action', 'requires_capture'].includes(selectedPayment.status) && (
                    <button
                      onClick={() => handleCancel(selectedPayment.id)}
                      className="btn-danger w-full"
                    >
                      Cancel Payment
                    </button>
                  )}
                </div>
              </div>
            </div>
          ) : (
            <div className="card card-body text-center text-stripe-gray-500">
              Select a payment to view details
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
