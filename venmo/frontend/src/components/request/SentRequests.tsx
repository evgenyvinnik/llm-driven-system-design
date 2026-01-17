/**
 * SentRequests component for displaying and managing outgoing payment requests.
 * Users can remind or cancel pending requests.
 */

import { useState } from 'react';
import { api } from '../../services/api';
import { LoadingSpinner } from '../LoadingSpinner';
import { RequestCard } from './RequestCard';
import type { PaymentRequest } from '../../types';

/**
 * Props for the SentRequests component.
 */
interface SentRequestsProps {
  /** List of sent payment requests */
  requests: PaymentRequest[];
  /** Whether the data is currently loading */
  isLoading: boolean;
  /** Callback to refresh the requests list */
  onUpdate: () => void;
}

/**
 * Renders a list of sent payment requests grouped by status.
 * Pending requests show Remind/Cancel buttons; completed ones are dimmed.
 */
export function SentRequests({
  requests,
  isLoading,
  onUpdate,
}: SentRequestsProps) {
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  /**
   * Handles cancelling a request.
   */
  const handleCancel = async (request: PaymentRequest) => {
    setActionLoading(request.id);
    try {
      await api.cancelRequest(request.id);
      onUpdate();
    } catch (error) {
      alert(error instanceof Error ? error.message : 'Failed to cancel');
    } finally {
      setActionLoading(null);
    }
  };

  /**
   * Handles sending a reminder for a pending request.
   */
  const handleRemind = async (request: PaymentRequest) => {
    setActionLoading(request.id);
    try {
      await api.remindRequest(request.id);
      alert('Reminder sent!');
    } catch (error) {
      alert(error instanceof Error ? error.message : 'Failed to send reminder');
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
    return <EmptyState message="No sent requests" />;
  }

  return (
    <div className="space-y-4">
      {pending.length > 0 && (
        <RequestSection title="Pending">
          {pending.map((request) => (
            <RequestCard
              key={request.id}
              request={request}
              mode="sent"
              primaryAction={{
                label: 'Remind',
                onClick: () => handleRemind(request),
                variant: 'secondary',
              }}
              secondaryAction={{
                label: 'Cancel',
                onClick: () => handleCancel(request),
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
              mode="sent"
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
