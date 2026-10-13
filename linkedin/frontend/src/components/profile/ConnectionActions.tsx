/**
 * Connection action buttons for someone else's profile, driven by the
 * server-reported relationship status rather than local guesses, so the
 * right button survives a reload (pending stays pending, an incoming
 * invitation can be accepted from the profile).
 *
 * @module components/profile/ConnectionActions
 */
import { Check, Clock, UserMinus, UserPlus, X } from 'lucide-react';
import type { Relationship } from '../../types';

interface ConnectionActionsProps {
  /** Relationship from GET /connections/degree/:userId (null while loading) */
  relationship: Relationship | null;
  /** True while a mutation is in flight; buttons are disabled */
  busy: boolean;
  onConnect: () => void;
  onWithdraw: () => void;
  onAccept: () => void;
  onIgnore: () => void;
  onRemove: () => void;
}

/**
 * Renders the button set for the current relationship state.
 *
 * @param props - Component props
 * @returns The action buttons
 */
export function ConnectionActions({
  relationship,
  busy,
  onConnect,
  onWithdraw,
  onAccept,
  onIgnore,
  onRemove,
}: ConnectionActionsProps) {
  if (!relationship) return null;

  switch (relationship.status) {
    case 'connected':
      return (
        <button onClick={onRemove} disabled={busy} className="btn-secondary flex items-center gap-2 disabled:opacity-50">
          <UserMinus className="w-4 h-4" aria-hidden="true" />
          Connected
        </button>
      );
    case 'pending_sent':
      return (
        <button
          onClick={onWithdraw}
          disabled={busy}
          className="btn-secondary flex items-center gap-2 disabled:opacity-50"
          aria-label="Pending. Withdraw invitation"
        >
          <Clock className="w-4 h-4" aria-hidden="true" />
          Pending
        </button>
      );
    case 'pending_received':
      return (
        <div className="flex gap-2">
          <button onClick={onAccept} disabled={busy} className="btn-primary flex items-center gap-1 disabled:opacity-50">
            <Check className="w-4 h-4" aria-hidden="true" />
            Accept
          </button>
          <button onClick={onIgnore} disabled={busy} className="btn-secondary flex items-center gap-1 disabled:opacity-50">
            <X className="w-4 h-4" aria-hidden="true" />
            Ignore
          </button>
        </div>
      );
    case 'none':
      return (
        <button onClick={onConnect} disabled={busy} className="btn-primary flex items-center gap-2 disabled:opacity-50">
          <UserPlus className="w-4 h-4" aria-hidden="true" />
          Connect
        </button>
      );
    default:
      return null;
  }
}
