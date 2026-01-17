/**
 * User Selector Component
 *
 * Row of user buttons for selecting which user to comment as.
 * Used in the demo to simulate different users.
 *
 * @module components/UserSelector
 */

import { User } from '../types';

/** Props for the UserSelector component */
interface UserSelectorProps {
  /** Array of available users */
  users: User[];
  /** ID of the currently selected user */
  selectedId: string | null;
  /** Callback when a user is selected */
  onSelect: (user: User) => void;
}

/**
 * Renders the user selection buttons.
 * Allows switching between different user identities in the demo.
 *
 * @param props - Component props with users and selection handler
 * @returns User selector JSX
 */
export function UserSelector({ users, selectedId, onSelect }: UserSelectorProps) {
  return (
    <div className="flex flex-col gap-2">
      <label className="text-sm text-gray-400">Commenting as:</label>
      <div className="flex flex-wrap gap-2">
        {users.map((user) => (
          <button
            key={user.id}
            onClick={() => onSelect(user)}
            className={`flex items-center gap-2 px-3 py-2 rounded-full transition-colors ${
              user.id === selectedId
                ? 'bg-blue-600 text-white'
                : 'bg-white/10 text-gray-300 hover:bg-white/20'
            }`}
          >
            {user.avatar_url ? (
              <img
                src={user.avatar_url}
                alt={user.display_name}
                className="w-6 h-6 rounded-full"
              />
            ) : (
              <div className="w-6 h-6 rounded-full bg-gradient-to-br from-blue-500 to-purple-500 flex items-center justify-center text-white text-xs font-bold">
                {user.display_name.charAt(0).toUpperCase()}
              </div>
            )}
            <span className="text-sm font-medium">{user.display_name}</span>
            {user.is_verified && (
              <span className="text-blue-400 text-xs">&#10003;</span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}
