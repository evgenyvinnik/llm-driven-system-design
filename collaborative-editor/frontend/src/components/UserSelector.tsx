import { useState, useEffect } from 'react';
import type { User } from '../types';
import { api } from '../services/api';

/**
 * Props for the UserSelector component.
 */
interface UserSelectorProps {
  /** Currently selected user's ID, or null if none */
  selectedUserId: string | null;
  /** Callback when a user is selected */
  onSelectUser: (userId: string) => void;
}

/**
 * UserSelector - Dropdown for selecting the current user.
 *
 * In a real application, this would be replaced with proper authentication.
 * For demo purposes, it allows switching between pre-seeded users.
 *
 * Displays:
 * - Dropdown with all available users
 * - Selected user's color indicator
 *
 * @param props - Component props
 * @returns The UserSelector component
 */
export function UserSelector({ selectedUserId, onSelectUser }: UserSelectorProps) {
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadUsers();
  }, []);

  async function loadUsers() {
    try {
      const userList = await api.getUsers();
      setUsers(userList);

      // Auto-select first user if none selected
      if (!selectedUserId && userList.length > 0) {
        onSelectUser(userList[0].id);
      }
    } catch (error) {
      console.error('Failed to load users:', error);
    } finally {
      setLoading(false);
    }
  }

  if (loading) {
    return <div className="text-gray-500 text-sm">Loading users...</div>;
  }

  const selectedUser = users.find(u => u.id === selectedUserId);

  return (
    <div className="flex items-center gap-2">
      <span className="text-sm text-gray-600">Logged in as:</span>
      <select
        value={selectedUserId || ''}
        onChange={(e) => onSelectUser(e.target.value)}
        className="px-3 py-1 border border-gray-300 rounded-lg text-sm bg-white"
      >
        {users.map((user) => (
          <option key={user.id} value={user.id}>
            {user.displayName}
          </option>
        ))}
      </select>
      {selectedUser && (
        <div
          className="w-4 h-4 rounded-full"
          style={{ backgroundColor: selectedUser.color }}
          title={selectedUser.displayName}
        />
      )}
    </div>
  );
}
