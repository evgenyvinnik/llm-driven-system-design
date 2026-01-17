/**
 * Connection card component for displaying user connection cards.
 * Used in PYMK suggestions, connection lists, and search results.
 * Supports connect button and remove connection actions.
 *
 * @module components/ConnectionCard
 */
import { Link } from '@tanstack/react-router';
import type { User, PYMKCandidate } from '../types';
import { connectionsApi } from '../services/api';
import { useState } from 'react';

/**
 * Props for the ConnectionCard component.
 */
interface ConnectionCardProps {
  user: User;
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
  const [connected, setConnected] = useState(false);

  const handleConnect = async () => {
    setConnecting(true);
    try {
      await connectionsApi.sendRequest(user.id);
      setConnected(true);
      onConnect?.();
    } catch (error) {
      console.error('Failed to send connection request:', error);
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
          {pymkData.mutual_connections > 0 && (
            <div>{pymkData.mutual_connections} mutual connection{pymkData.mutual_connections > 1 ? 's' : ''}</div>
          )}
          {pymkData.same_company && <div>Works at same company</div>}
          {pymkData.same_school && <div>Same school</div>}
        </div>
      )}

      {showConnectButton && !connected && (
        <button
          onClick={handleConnect}
          disabled={connecting}
          className="mt-4 btn-secondary text-sm w-full disabled:opacity-50"
        >
          {connecting ? 'Sending...' : 'Connect'}
        </button>
      )}

      {connected && (
        <div className="mt-4 text-sm text-gray-600">Request sent</div>
      )}

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
