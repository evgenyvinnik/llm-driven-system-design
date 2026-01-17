import { createFileRoute } from '@tanstack/react-router';
import { useEffect } from 'react';
import { Layout } from '../components/Layout';
import { TransactionItem, TransactionSkeleton } from '../components/TransactionItem';
import { useTransactionStore } from '../stores';

export const Route = createFileRoute('/transactions')({
  component: TransactionsPage,
});

function TransactionsPage() {
  const { transactions, total, isLoading, loadTransactions } = useTransactionStore();

  useEffect(() => {
    loadTransactions({ limit: 50 });
  }, [loadTransactions]);

  const groupedTransactions = transactions.reduce(
    (groups, tx) => {
      const date = new Date(tx.created_at);
      const today = new Date();
      const yesterday = new Date(today);
      yesterday.setDate(yesterday.getDate() - 1);

      let key: string;
      if (date.toDateString() === today.toDateString()) {
        key = 'Today';
      } else if (date.toDateString() === yesterday.toDateString()) {
        key = 'Yesterday';
      } else {
        key = date.toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
      }

      if (!groups[key]) {
        groups[key] = [];
      }
      groups[key].push(tx);
      return groups;
    },
    {} as Record<string, typeof transactions>
  );

  return (
    <Layout title="Transaction History">
      {isLoading && transactions.length === 0 ? (
        <div className="space-y-3">
          <TransactionSkeleton />
          <TransactionSkeleton />
          <TransactionSkeleton />
        </div>
      ) : transactions.length === 0 ? (
        <div className="text-center py-16 text-apple-gray-500">
          <svg className="w-16 h-16 mx-auto mb-4 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <p>No transactions yet</p>
          <p className="text-sm">Your payment history will appear here</p>
        </div>
      ) : (
        <div className="space-y-6">
          {Object.entries(groupedTransactions).map(([date, txs]) => (
            <section key={date}>
              <h3 className="text-sm font-semibold text-apple-gray-500 uppercase tracking-wide mb-3">
                {date}
              </h3>
              <div className="space-y-2">
                {txs.map((tx) => (
                  <TransactionItem key={tx.id} transaction={tx} />
                ))}
              </div>
            </section>
          ))}

          {total > transactions.length && (
            <button
              onClick={() => loadTransactions({ limit: transactions.length + 50 })}
              className="btn-secondary w-full"
            >
              Load More
            </button>
          )}
        </div>
      )}
    </Layout>
  );
}
