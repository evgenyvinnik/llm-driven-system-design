/**
 * Connection card component for displaying user connection cards.
 * Used in PYMK suggestions, connection lists, and search results.
 * Supports connect button and remove connection actions.
 *
 * @module components/ConnectionCard
 */
import { Link } from '@tanstack/react-router';
import type { UserSummary, PYMKCandidate } from '../types';
import { connectionsApi } from '../services/api';
import { useState } from 'react';

/**
 * Props for the ConnectionCard component.
 */
interface ConnectionCardProps {
  user: UserSummary;
  pymkData?: PYMKCandidate;
  onConnect?: () => void;
  showConnectButton?: boolean;
  showRemoveButton?: boolean;
  onRemove?: () => void;
}

/**
 * Displays a user card with connection actions.
 * Shows profile photo, name, headline, and optional PYMK match reasons.
 * Provides connect button for suggestions and remove button for existing connections.
 *
 * @param user - The user to display
 * @param pymkData - Optional PYMK data with match reasons
 * @param onConnect - Callback when connection request is sent
 * @param showConnectButton - Whether to show the connect button
 * @param showRemoveButton - Whether to show the remove connection button
 * @param onRemove - Callback when connection is removed
 */
export function ConnectionCard({
  user,
  pymkData,
  onConnect,
  showConnectButton = false,
  showRemoveButton = false,
  onRemove,
}: ConnectionCardProps) {
  const [connecting, setConnecting] = useState(false);
  const [sentStatus, setSentStatus] = useState<'pending_sent' | 'connected' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleConnect = async () => {
    setConnecting(true);
    setError(null);
    try {
      const result = await connectionsApi.sendRequest(user.id);
      setSentStatus(result.status);
      onConnect?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send invitation');
    }
    setConnecting(false);
  };

  const handleRemove = async () => {
    try {
      await connectionsApi.removeConnection(user.id);
      onRemove?.();
    } catch (error) {
      console.error('Failed to remove connection:', error);
    }
  };

  return (
    <div className="card p-4 text-center">
      <Link to="/profile/$userId" params={{ userId: String(user.id) }}>
        <div className="w-20 h-20 mx-auto rounded-full bg-gray-300 flex items-center justify-center text-2xl font-bold">
          {user.profile_image_url ? (
            <img
              src={user.profile_image_url}
              alt={user.first_name}
              className="w-full h-full rounded-full object-cover"
            />
          ) : (
            user.first_name?.[0]
          )}
        </div>
      </Link>

      <Link
        to="/profile/$userId"
        params={{ userId: String(user.id) }}
        className="mt-3 block font-semibold hover:text-linkedin-blue hover:underline"
      >
        {user.first_name} {user.last_name}
      </Link>

      <div className="text-sm text-gray-600 mt-1 line-clamp-2 min-h-[40px]">
        {user.headline}
      </div>

      {pymkData && (
        <div className="mt-2 text-xs text-gray-500 space-y-1">
          {(pymkData.reasons ?? []).slice(0, 2).map((reason) => (
            <div key={reason}>{reason}</div>
          ))}
        </div>
      )}

      {showConnectButton && !sentStatus && (
        <button
          onClick={handleConnect}
          disabled={connecting}
          className="mt-4 btn-secondary text-sm w-full disabled:opacity-50"
        >
          {connecting ? 'Sending...' : 'Connect'}
        </button>
      )}

      <div role="status" aria-live="polite" className="mt-2 text-sm">
        {sentStatus === 'pending_sent' && <span className="text-gray-600">Request sent</span>}
        {sentStatus === 'connected' && <span className="text-green-700">Connected</span>}
        {error && <span className="text-red-600">{error}</span>}
      </div>

      {showRemoveButton && (
        <button
          onClick={handleRemove}
          className="mt-4 text-sm text-gray-600 hover:text-red-600"
        >
          Remove connection
        </button>
      )}
    </div>
  );
}
