import { useState } from 'react';
import type { TransferRequest } from '../types';
import { requestsApi } from '../services/api';
import { formatCents } from '../utils/money';
import { StatusBadge } from './StatusBadge';

interface RequestCardProps {
  request: TransferRequest;
  currentUserId: string;
  onAction: () => void;
}

/** Displays a transfer request with pay/decline actions for the payer or cancel for the requester. */
export function RequestCard({ request, currentUserId, onAction }: RequestCardProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const isPayer = request.payerId === currentUserId;

  // Errors such as "Insufficient funds" or "Request is already paid" used to be
  // swallowed, so a failed payment looked like nothing happened.
  const run = async (action: () => Promise<unknown>) => {
    setLoading(true);
    setError('');
    try {
      await action();
      onAction();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed');
    }
    setLoading(false);
  };

  return (
    <div className="p-4 bg-paypal-bg rounded-lg">
      <div className="flex items-center justify-between">
        <div>
          <div className="font-medium text-paypal-text text-sm">
            {isPayer
              ? `${request.requesterDisplayName || request.requesterUsername} requested`
              : `You requested from ${request.payerDisplayName || request.payerUsername}`
            }
          </div>
          <div className="text-lg font-bold text-paypal-text">
            {formatCents(request.amountCents)}
          </div>
          {request.note && (
            <div className="text-xs text-paypal-secondary mt-1">{request.note}</div>
          )}
        </div>

        {request.status === 'pending' && isPayer && (
          <div className="flex space-x-2">
            <button
              onClick={() => run(() => requestsApi.pay(request.id))}
              disabled={loading}
              className="px-4 py-1.5 bg-paypal-primary text-white rounded-lg hover:bg-paypal-hover text-sm font-medium disabled:opacity-50"
            >
              Pay
            </button>
            <button
              onClick={() => run(() => requestsApi.decline(request.id))}
              disabled={loading}
              className="px-4 py-1.5 border border-paypal-border text-paypal-text rounded-lg hover:bg-gray-50 text-sm font-medium disabled:opacity-50"
            >
              Decline
            </button>
          </div>
        )}

        {request.status === 'pending' && !isPayer && (
          <button
            onClick={() => run(() => requestsApi.cancel(request.id))}
            disabled={loading}
            className="px-4 py-1.5 border border-paypal-border text-paypal-secondary rounded-lg hover:bg-gray-50 text-sm disabled:opacity-50"
          >
            Cancel
          </button>
        )}

        {request.status !== 'pending' && <StatusBadge status={request.status} />}
      </div>
      {error && <div className="mt-2 text-sm text-paypal-danger">{error}</div>}
    </div>
  );
}
