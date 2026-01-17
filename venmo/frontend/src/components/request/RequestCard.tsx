/**
 * RequestCard component for displaying a single payment request.
 * Used by both ReceivedRequests and SentRequests components.
 */

import { Avatar } from '../Avatar';
import { Button } from '../Button';
import { RequestStatusBadge } from './RequestStatusBadge';
import { formatCurrency, formatDate } from '../../utils';
import type { PaymentRequest } from '../../types';

/**
 * Props for the RequestCard component.
 */
interface RequestCardProps {
  /** The payment request to display */
  request: PaymentRequest;
  /** Display mode - 'received' shows requester info, 'sent' shows requestee info */
  mode: 'received' | 'sent';
  /** Primary action button config (e.g., Pay, Remind) */
  primaryAction?: {
    label: string;
    onClick: () => void;
    loading?: boolean;
    variant?: 'primary' | 'secondary';
  };
  /** Secondary action button config (e.g., Decline, Cancel) */
  secondaryAction?: {
    label: string;
    onClick: () => void;
    disabled?: boolean;
  };
  /** Whether to show the request as completed (dimmed) */
  isCompleted?: boolean;
}

/**
 * Renders a card displaying a payment request with optional action buttons.
 */
export function RequestCard({
  request,
  mode,
  primaryAction,
  secondaryAction,
  isCompleted = false,
}: RequestCardProps) {
  const person = mode === 'received'
    ? {
        name: request.requester_name,
        username: request.requester_username,
        avatar: request.requester_avatar,
      }
    : {
        name: request.requestee_name,
        username: request.requestee_username,
        avatar: request.requestee_avatar,
      };

  return (
    <div
      className={`bg-white rounded-lg shadow-sm p-4 mb-3 ${
        isCompleted ? 'opacity-75' : ''
      }`}
    >
      <div className="flex items-start gap-3">
        <Avatar src={person.avatar} name={person.name || ''} />
        <RequestInfo
          name={person.name}
          username={person.username}
          note={request.note}
          createdAt={request.created_at}
          showUsername={!isCompleted}
        />
        <RequestAmount
          amount={request.amount}
          status={isCompleted ? request.status : undefined}
        />
      </div>

      {(primaryAction || secondaryAction) && (
        <div className="flex gap-2 mt-4">
          {primaryAction && (
            <Button
              onClick={primaryAction.onClick}
              loading={primaryAction.loading}
              variant={primaryAction.variant}
              size="sm"
              className="flex-1"
            >
              {primaryAction.label}
            </Button>
          )}
          {secondaryAction && (
            <Button
              onClick={secondaryAction.onClick}
              variant="outline"
              size="sm"
              className="flex-1"
              disabled={secondaryAction.disabled}
            >
              {secondaryAction.label}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Props for the RequestInfo component.
 */
interface RequestInfoProps {
  /** Person's display name */
  name?: string;
  /** Person's username */
  username?: string;
  /** Request note/description */
  note?: string;
  /** When the request was created */
  createdAt: string;
  /** Whether to show the username */
  showUsername: boolean;
}

/**
 * Displays request details including person info, note, and date.
 */
function RequestInfo({
  name,
  username,
  note,
  createdAt,
  showUsername,
}: RequestInfoProps) {
  return (
    <div className="flex-1">
      <p className="font-medium">{name}</p>
      {showUsername && (
        <p className="text-gray-500 text-sm">@{username}</p>
      )}
      {note && <p className="text-gray-700 mt-1">{note}</p>}
      <p className="text-sm text-gray-400 mt-1">{formatDate(createdAt)}</p>
    </div>
  );
}

/**
 * Props for the RequestAmount component.
 */
interface RequestAmountProps {
  /** Amount in cents */
  amount: number;
  /** Optional status to show badge for completed requests */
  status?: 'pending' | 'paid' | 'declined' | 'cancelled';
}

/**
 * Displays the request amount and optional status badge.
 */
function RequestAmount({ amount, status }: RequestAmountProps) {
  if (status) {
    return (
      <div className="text-right">
        <p className="text-lg font-semibold">{formatCurrency(amount)}</p>
        <RequestStatusBadge status={status} />
      </div>
    );
  }

  return <p className="text-lg font-semibold">{formatCurrency(amount)}</p>;
}
