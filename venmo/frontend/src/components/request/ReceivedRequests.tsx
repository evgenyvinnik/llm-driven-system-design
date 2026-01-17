/**
 * ReceivedRequests component for displaying and managing incoming payment requests.
 * Users can pay or decline pending requests.
 */

import { useState } from 'react';
import { api } from '../../services/api';
import { useAuthStore } from '../../stores';
import { LoadingSpinner } from '../LoadingSpinner';
import { RequestCard } from './RequestCard';
import type { PaymentRequest } from '../../types';

/**
 * Props for the ReceivedRequests component.
 */
interface ReceivedRequestsProps {
  /** List of received payment requests */
  requests: PaymentRequest[];
  /** Whether the data is currently loading */
  isLoading: boolean;
  /** Callback to refresh the requests list */
  onUpdate: () => void;
}

/**
 * Renders a list of received payment requests grouped by status.
 * Pending requests show Pay/Decline buttons; completed ones are dimmed.
 */
export function ReceivedRequests({
  requests,
  isLoading,
  onUpdate,
}: ReceivedRequestsProps) {
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const { checkAuth } = useAuthStore();

  /**
   * Handles paying a request.
   * Processes the payment and refreshes auth state (balance may have changed).
   */
  const handlePay = async (request: PaymentRequest) => {
    setActionLoading(request.id);
    try {
      await api.payRequest(request.id);
      await checkAuth();
      onUpdate();
    } catch (error) {
      alert(error instanceof Error ? error.message : 'Payment failed');
    } finally {
      setActionLoading(null);
    }
  };

  /**
   * Handles declining a request.
   */
  const handleDecline = async (request: PaymentRequest) => {
    setActionLoading(request.id);
    try {
      await api.declineRequest(request.id);
      onUpdate();
    } catch (error) {
      alert(error instanceof Error ? error.message : 'Failed to decline');
    } finally {
      setActionLoading(null);
    }
  };

  if (isLoading) {
    return <LoadingSpinner />;
  }

  const pending = requests.filter((r) => r.status === 'pending');
  const completed = requests.filter((r) => r.status !== 'pending');

  if (requests.length === 0) {
    return <EmptyState message="No received requests" />;
  }

  return (
    <div className="space-y-4">
      {pending.length > 0 && (
        <RequestSection title="Pending">
          {pending.map((request) => (
            <RequestCard
              key={request.id}
              request={request}
              mode="received"
              primaryAction={{
                label: 'Pay',
                onClick: () => handlePay(request),
                loading: actionLoading === request.id,
              }}
              secondaryAction={{
                label: 'Decline',
                onClick: () => handleDecline(request),
                disabled: actionLoading === request.id,
              }}
            />
          ))}
        </RequestSection>
      )}

      {completed.length > 0 && (
        <RequestSection title="Completed">
          {completed.map((request) => (
            <RequestCard
              key={request.id}
              request={request}
              mode="received"
              isCompleted
            />
          ))}
        </RequestSection>
      )}
    </div>
  );
}

/**
 * Props for the RequestSection component.
 */
interface RequestSectionProps {
  /** Section title */
  title: string;
  /** Section content */
  children: React.ReactNode;
}

/**
 * Renders a section with a title and content.
 */
function RequestSection({ title, children }: RequestSectionProps) {
  return (
    <div>
      <h3 className="text-sm font-medium text-gray-500 mb-2">{title}</h3>
      {children}
    </div>
  );
}

/**
 * Props for the EmptyState component.
 */
interface EmptyStateProps {
  /** Message to display */
  message: string;
}

/**
 * Renders an empty state message.
 */
function EmptyState({ message }: EmptyStateProps) {
  return (
    <div className="bg-white rounded-lg shadow-sm p-8 text-center">
      <p className="text-gray-500">{message}</p>
    </div>
  );
}
