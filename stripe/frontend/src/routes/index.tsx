/**
 * Dashboard Route
 *
 * The main dashboard page showing an overview of payment activity.
 * Displays summary statistics, recent payment intents, and charges
 * to give merchants a quick view of their business performance.
 *
 * @module routes/index
 */

import { createFileRoute } from '@tanstack/react-router';
import { useState, useEffect } from 'react';
import { getBalanceSummary, listPaymentIntents, listCharges } from '@/services/api';
import { formatCurrency, formatRelativeTime } from '@/utils';
import { StatusBadge, CardDisplay } from '@/components';
import type { BalanceSummary, PaymentIntent, Charge } from '@/types';

/**
 * Route definition for the dashboard page (/).
 */
export const Route = createFileRoute('/')({
  component: Dashboard,
});

/**
 * Dashboard page component.
 * Fetches and displays balance summary, recent payment intents,
 * and recent charges in a grid layout with statistics cards.
 *
 * @returns The dashboard page content
 */
function Dashboard() {
  const [summary, setSummary] = useState<BalanceSummary | null>(null);
  const [recentPayments, setRecentPayments] = useState<PaymentIntent[]>([]);
  const [recentCharges, setRecentCharges] = useState<Charge[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    loadData();
  }, []);

  /**
   * Fetches dashboard data from the API.
   * Loads balance summary, payment intents, and charges in parallel.
   */
  async function loadData() {
    try {
      setLoading(true);
      const [summaryData, paymentsData, chargesData] = await Promise.all([
        getBalanceSummary(),
        listPaymentIntents({ limit: 5 }),
        listCharges({ limit: 5 }),
      ]);
      setSummary(summaryData);
      setRecentPayments(paymentsData.data);
      setRecentCharges(chargesData.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load dashboard');
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

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-stripe-gray-900">Dashboard</h1>
        <p className="text-stripe-gray-500 mt-1">Overview of your payment activity</p>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        <StatCard
          title="Available Balance"
          value={formatCurrency(summary?.lifetime.total_net || 0)}
          subtitle="USD"
        />
        <StatCard
          title="Today's Volume"
          value={formatCurrency(summary?.today.amount || 0)}
          subtitle={`${summary?.today.charges || 0} charges`}
        />
        <StatCard
          title="Total Processed"
          value={formatCurrency(summary?.lifetime.total_amount || 0)}
          subtitle={`${summary?.lifetime.successful_charges || 0} successful`}
        />
        <StatCard
          title="Processing Fees"
          value={formatCurrency(summary?.lifetime.total_fees || 0)}
          subtitle="2.9% + 30c per charge"
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        {/* Recent Payments */}
        <div className="card">
          <div className="card-header flex items-center justify-between">
            <h2 className="font-semibold text-stripe-gray-900">Recent Payment Intents</h2>
            <a href="/payments" className="text-sm text-stripe-purple hover:underline">
              View all
            </a>
          </div>
          <div className="divide-y divide-stripe-gray-100">
            {recentPayments.length === 0 ? (
              <div className="p-6 text-center text-stripe-gray-500">
                No payment intents yet
              </div>
            ) : (
              recentPayments.map((pi) => (
                <div key={pi.id} className="px-6 py-4 flex items-center justify-between">
                  <div>
                    <div className="font-medium text-stripe-gray-900">
                      {formatCurrency(pi.amount, pi.currency)}
                    </div>
                    <div className="text-sm text-stripe-gray-500">
                      {formatRelativeTime(pi.created)}
                    </div>
                  </div>
                  <StatusBadge status={pi.status} />
                </div>
              ))
            )}
          </div>
        </div>

        {/* Recent Charges */}
        <div className="card">
          <div className="card-header flex items-center justify-between">
            <h2 className="font-semibold text-stripe-gray-900">Recent Charges</h2>
            <a href="/payments" className="text-sm text-stripe-purple hover:underline">
              View all
            </a>
          </div>
          <div className="divide-y divide-stripe-gray-100">
            {recentCharges.length === 0 ? (
              <div className="p-6 text-center text-stripe-gray-500">
                No charges yet
              </div>
            ) : (
              recentCharges.map((charge) => (
                <div key={charge.id} className="px-6 py-4 flex items-center justify-between">
                  <div>
                    <div className="font-medium text-stripe-gray-900">
                      {formatCurrency(charge.amount, charge.currency)}
                    </div>
                    <div className="text-sm text-stripe-gray-500 flex items-center gap-2">
                      {charge.payment_method_details?.card && (
                        <CardDisplay
                          brand={charge.payment_method_details.card.brand}
                          last4={charge.payment_method_details.card.last4}
                        />
                      )}
                    </div>
                  </div>
                  <div className="text-right">
                    <StatusBadge status={charge.status} />
                    <div className="text-xs text-stripe-gray-500 mt-1">
                      Fee: {formatCurrency(charge.fee)}
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* Quick Stats */}
      <div className="card">
        <div className="card-header">
          <h2 className="font-semibold text-stripe-gray-900">Lifetime Statistics</h2>
        </div>
        <div className="card-body grid grid-cols-2 md:grid-cols-4 gap-6">
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
            <div className="text-sm text-stripe-gray-500">Total Refunded</div>
            <div className="text-2xl font-bold text-orange-600">
              {formatCurrency(summary?.lifetime.total_refunded || 0)}
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
    </div>
  );
}

/**
 * Statistics card component.
 * Displays a single metric with title, value, and subtitle.
 *
 * @param props - Card properties
 * @param props.title - Label above the value
 * @param props.value - The main metric value
 * @param props.subtitle - Additional context below the value
 * @returns A styled card element
 */
function StatCard({ title, value, subtitle }: { title: string; value: string; subtitle: string }) {
  return (
    <div className="card card-body">
      <div className="text-sm text-stripe-gray-500">{title}</div>
      <div className="text-2xl font-bold text-stripe-gray-900 mt-1">{value}</div>
      <div className="text-xs text-stripe-gray-400 mt-1">{subtitle}</div>
    </div>
  );
}
