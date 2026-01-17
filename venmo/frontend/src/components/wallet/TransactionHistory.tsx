/**
 * TransactionHistory component displaying a list of past transactions.
 * Shows both sent and received transfers with visual indicators.
 */

import { useState, useEffect } from 'react';
import { api } from '../../services/api';
import { useAuthStore } from '../../stores';
import { LoadingSpinner } from '../LoadingSpinner';
import { ArrowIcon } from '../icons';
import { formatCurrency, formatDate } from '../../utils';
import type { Transfer } from '../../types';

/**
 * Renders the transaction history with loading state and empty state handling.
 * Transactions are displayed with direction indicators and formatted amounts.
 */
export function TransactionHistory() {
  const [transactions, setTransactions] = useState<Transfer[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const { user } = useAuthStore();

  /**
   * Load transaction history on component mount.
   */
  useEffect(() => {
    api
      .getTransactionHistory()
      .then(setTransactions)
      .catch(() => {})
      .finally(() => setIsLoading(false));
  }, []);

  if (isLoading) {
    return <LoadingSpinner />;
  }

  if (transactions.length === 0) {
    return <EmptyTransactionHistory />;
  }

  return (
    <div className="bg-white rounded-lg shadow-sm">
      <div className="divide-y">
        {transactions.map((tx) => {
          const isSent = tx.sender_id === user?.id;
          return (
            <TransactionItem
              key={tx.id}
              transaction={tx}
              isSent={isSent}
            />
          );
        })}
      </div>
    </div>
  );
}

/**
 * Renders an empty state when there are no transactions.
 */
function EmptyTransactionHistory() {
  return (
    <div className="bg-white rounded-lg shadow-sm">
      <div className="p-8 text-center">
        <p className="text-gray-500">No transactions yet</p>
      </div>
    </div>
  );
}

/**
 * Props for the TransactionItem component.
 */
interface TransactionItemProps {
  /** The transaction to display */
  transaction: Transfer;
  /** Whether this transaction was sent by the current user */
  isSent: boolean;
}

/**
 * Renders a single transaction item with direction icon, counterparty info, and amount.
 */
function TransactionItem({ transaction: tx, isSent }: TransactionItemProps) {
  return (
    <div className="p-4 flex items-center gap-3">
      <TransactionIcon isSent={isSent} />
      <div className="flex-1">
        <p className="font-medium">
          {isSent ? tx.receiver_name : tx.sender_name}
        </p>
        <p className="text-sm text-gray-500">{tx.note || 'No note'}</p>
        <p className="text-xs text-gray-400">{formatDate(tx.created_at)}</p>
      </div>
      <p className={`font-semibold ${isSent ? 'text-red-600' : 'text-green-600'}`}>
        {isSent ? '-' : '+'}
        {formatCurrency(tx.amount)}
      </p>
    </div>
  );
}

/**
 * Props for the TransactionIcon component.
 */
interface TransactionIconProps {
  /** Whether the transaction was sent by the current user */
  isSent: boolean;
}

/**
 * Renders a directional icon indicating if transaction was sent or received.
 */
function TransactionIcon({ isSent }: TransactionIconProps) {
  return (
    <div
      className={`w-10 h-10 rounded-full flex items-center justify-center ${
        isSent ? 'bg-red-100 text-red-600' : 'bg-green-100 text-green-600'
      }`}
    >
      <ArrowIcon
        className="w-5 h-5"
        direction={isSent ? 'up-right' : 'down-left'}
      />
    </div>
  );
}
