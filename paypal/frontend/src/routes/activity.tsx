import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useAuthStore } from '../stores/authStore';
import { transfersApi } from '../services/api';
import type { Transaction } from '../types';
import { TransactionList } from '../components/TransactionList';
import { ActivityFilters } from '../components/ActivityFilters';

function ActivityPage() {
  const user = useAuthStore((s) => s.user);
  const loading = useAuthStore((s) => s.loading);
  const navigate = useNavigate();

  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [dataLoading, setDataLoading] = useState(true);
  const [filter, setFilter] = useState<string>('');

  useEffect(() => {
    if (!loading && !user) {
      navigate({ to: '/login' });
    }
  }, [user, loading, navigate]);

  useEffect(() => {
    if (!user) return;
    // Ignore a response that arrives after the filter has changed again, so a
    // slow "All" request can't overwrite the "Deposits" list.
    let stale = false;
    setDataLoading(true);
    transfersApi
      .list(filter || undefined)
      .then((res) => !stale && setTransactions(res.transactions))
      .catch(() => undefined)
      .finally(() => !stale && setDataLoading(false));
    return () => {
      stale = true;
    };
  }, [user, filter]);

  if (loading || !user) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="text-paypal-secondary">Loading...</div>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      <h1 className="text-2xl font-bold text-paypal-text mb-6">Activity</h1>

      <div className="bg-white rounded-xl shadow-sm border border-paypal-border p-6">
        <ActivityFilters currentFilter={filter} onFilterChange={setFilter} />
        <TransactionList
          transactions={transactions}
          currentUserId={user.id}
          loading={dataLoading}
          showDate
        />
      </div>
    </div>
  );
}

export const Route = createFileRoute('/activity')({
  component: ActivityPage,
});
