/**
 * RecentCashouts component for displaying a list of recent cashout transactions.
 */

import type { Cashout } from '../../types';
import { formatCurrency, formatDate } from '../../utils';

/**
 * Props for the RecentCashouts component.
 */
interface RecentCashoutsProps {
  /** Array of cashout transactions to display */
  cashouts: Cashout[];
  /** Maximum number of cashouts to show (default: 5) */
  limit?: number;
}

/**
 * Renders a list of recent cashout transactions with their status.
 * Only renders if there are cashouts to display.
 */
export function RecentCashouts({ cashouts, limit = 5 }: RecentCashoutsProps) {
  if (cashouts.length === 0) {
    return null;
  }

  return (
    <div className="bg-white rounded-lg shadow-sm p-4">
      <h3 className="font-medium mb-3">Recent Cashouts</h3>
      <div className="space-y-3">
        {cashouts.slice(0, limit).map((cashout) => (
          <CashoutItem key={cashout.id} cashout={cashout} />
        ))}
      </div>
    </div>
  );
}

/**
 * Props for the CashoutItem component.
 */
interface CashoutItemProps {
  /** The cashout transaction to display */
  cashout: Cashout;
}

/**
 * Renders a single cashout item with amount, speed, date, and status.
 */
function CashoutItem({ cashout }: CashoutItemProps) {
  return (
    <div className="flex justify-between items-center py-2 border-b last:border-0">
      <div>
        <p className="font-medium">{formatCurrency(cashout.amount)}</p>
        <p className="text-sm text-gray-500">
          {cashout.speed === 'instant' ? 'Instant' : 'Standard'} -{' '}
          {formatDate(cashout.created_at)}
        </p>
      </div>
      <CashoutStatusBadge status={cashout.status} />
    </div>
  );
}

/**
 * Props for the CashoutStatusBadge component.
 */
interface CashoutStatusBadgeProps {
  /** The status of the cashout */
  status: string;
}

/**
 * Renders a colored badge indicating the cashout status.
 */
function CashoutStatusBadge({ status }: CashoutStatusBadgeProps) {
  const getStatusClasses = () => {
    switch (status) {
      case 'completed':
        return 'bg-green-100 text-green-700';
      case 'processing':
        return 'bg-yellow-100 text-yellow-700';
      default:
        return 'bg-gray-100 text-gray-700';
    }
  };

  return (
    <span className={`text-xs px-2 py-1 rounded-full ${getStatusClasses()}`}>
      {status}
    </span>
  );
}
