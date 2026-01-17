import type { Transaction } from '../types';

interface TransactionItemProps {
  transaction: Transaction;
  onClick?: () => void;
}

const statusColors = {
  pending: 'text-apple-orange',
  approved: 'text-apple-green',
  declined: 'text-apple-red',
  refunded: 'text-apple-gray-500',
};

const statusLabels = {
  pending: 'Pending',
  approved: 'Approved',
  declined: 'Declined',
  refunded: 'Refunded',
};

const typeIcons = {
  nfc: (
    <svg className="w-6 h-6" viewBox="0 0 24 24" fill="currentColor">
      <path d="M20 2H4c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 18H4V4h16v16zM8.5 15H10c.28 0 .5.22.5.5v1c0 .28-.22.5-.5.5H8.5c-.28 0-.5-.22-.5-.5v-1c0-.28.22-.5.5-.5zm6 0h1.5c.28 0 .5.22.5.5v1c0 .28-.22.5-.5.5H14.5c-.28 0-.5-.22-.5-.5v-1c0-.28.22-.5.5-.5zM12 7c-2.76 0-5 2.24-5 5h2c0-1.66 1.34-3 3-3s3 1.34 3 3h2c0-2.76-2.24-5-5-5z" />
    </svg>
  ),
  in_app: (
    <svg className="w-6 h-6" viewBox="0 0 24 24" fill="currentColor">
      <path d="M17 1.01L7 1c-1.1 0-2 .9-2 2v18c0 1.1.9 2 2 2h10c1.1 0 2-.9 2-2V3c0-1.1-.9-1.99-2-1.99zM17 19H7V5h10v14z" />
    </svg>
  ),
  web: (
    <svg className="w-6 h-6" viewBox="0 0 24 24" fill="currentColor">
      <path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zm6.93 6h-2.95c-.32-1.25-.78-2.45-1.38-3.56 1.84.63 3.37 1.91 4.33 3.56zM12 4.04c.83 1.2 1.48 2.53 1.91 3.96h-3.82c.43-1.43 1.08-2.76 1.91-3.96zM4.26 14C4.1 13.36 4 12.69 4 12s.1-1.36.26-2h3.38c-.08.66-.14 1.32-.14 2 0 .68.06 1.34.14 2H4.26zm.82 2h2.95c.32 1.25.78 2.45 1.38 3.56-1.84-.63-3.37-1.9-4.33-3.56zm2.95-8H5.08c.96-1.66 2.49-2.93 4.33-3.56C8.81 5.55 8.35 6.75 8.03 8zM12 19.96c-.83-1.2-1.48-2.53-1.91-3.96h3.82c-.43 1.43-1.08 2.76-1.91 3.96zM14.34 14H9.66c-.09-.66-.16-1.32-.16-2 0-.68.07-1.35.16-2h4.68c.09.65.16 1.32.16 2 0 .68-.07 1.34-.16 2zm.25 5.56c.6-1.11 1.06-2.31 1.38-3.56h2.95c-.96 1.65-2.49 2.93-4.33 3.56zM16.36 14c.08-.66.14-1.32.14-2 0-.68-.06-1.34-.14-2h3.38c.16.64.26 1.31.26 2s-.1 1.36-.26 2h-3.38z" />
    </svg>
  ),
};

function formatCurrency(amount: number, currency: string): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
  }).format(amount);
}

function formatDate(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) {
    return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  } else if (diffDays === 1) {
    return 'Yesterday';
  } else if (diffDays < 7) {
    return date.toLocaleDateString('en-US', { weekday: 'long' });
  } else {
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }
}

export function TransactionItem({ transaction, onClick }: TransactionItemProps) {
  const isRefund = transaction.amount < 0;

  return (
    <div
      onClick={onClick}
      className="flex items-center gap-4 p-4 bg-white rounded-xl cursor-pointer hover:bg-apple-gray-50 transition-colors"
    >
      <div className="w-12 h-12 rounded-full bg-apple-gray-100 flex items-center justify-center text-apple-gray-600">
        {typeIcons[transaction.transaction_type]}
      </div>

      <div className="flex-1 min-w-0">
        <div className="font-medium text-apple-gray-900 truncate">
          {transaction.merchant_name || 'Unknown Merchant'}
        </div>
        <div className="text-sm text-apple-gray-500 flex items-center gap-2">
          <span className={statusColors[transaction.status]}>
            {statusLabels[transaction.status]}
          </span>
          <span className="text-apple-gray-300">|</span>
          <span>{formatDate(transaction.created_at)}</span>
        </div>
      </div>

      <div className="text-right">
        <div className={`font-semibold ${isRefund ? 'text-apple-green' : 'text-apple-gray-900'}`}>
          {isRefund ? '+' : ''}{formatCurrency(Math.abs(transaction.amount), transaction.currency)}
        </div>
        {transaction.last4 && (
          <div className="text-sm text-apple-gray-500">
            ****{transaction.last4}
          </div>
        )}
      </div>
    </div>
  );
}

export function TransactionSkeleton() {
  return (
    <div className="flex items-center gap-4 p-4 bg-white rounded-xl">
      <div className="w-12 h-12 rounded-full bg-apple-gray-200 shimmer" />
      <div className="flex-1">
        <div className="h-4 w-32 bg-apple-gray-200 rounded shimmer mb-2" />
        <div className="h-3 w-24 bg-apple-gray-200 rounded shimmer" />
      </div>
      <div className="text-right">
        <div className="h-4 w-16 bg-apple-gray-200 rounded shimmer mb-2" />
        <div className="h-3 w-12 bg-apple-gray-200 rounded shimmer" />
      </div>
    </div>
  );
}
