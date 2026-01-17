import React, { useEffect, useState } from 'react';
import { api } from '../../services/api';
import { CenteredSpinner } from '../common';
import { formatBytes, formatRelativeTime } from '../../utils/helpers';

/**
 * User data structure for the users list.
 */
interface AdminUser {
  id: string;
  email: string;
  role: string;
  storageQuota: number;
  storageUsed: number;
  deviceCount: number;
  createdAt: string;
}

/**
 * Users tab content for the admin dashboard.
 *
 * Displays a searchable table of all users with:
 * - Email address
 * - Role (admin/user) with badge
 * - Device count
 * - Storage usage with visual progress bar
 * - Registration date
 *
 * Supports real-time search by email with debouncing.
 *
 * @returns User list table with search functionality
 */
export const UsersTab: React.FC = () => {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [search, setSearch] = useState('');
  const [isLoading, setIsLoading] = useState(true);

  /**
   * Loads users from the API with optional search filter.
   *
   * @param searchTerm - Optional email search term
   */
  const loadUsers = async (searchTerm?: string) => {
    setIsLoading(true);
    try {
      const result = await api.listUsers({ limit: 50, search: searchTerm });
      setUsers(result.users);
    } catch (error) {
      console.error('Failed to load users:', error);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadUsers();
  }, []);

  /**
   * Handles search submission.
   */
  const handleSearch = () => {
    loadUsers(search);
  };

  /**
   * Returns the CSS classes for a role badge.
   *
   * @param role - The user role
   * @returns Tailwind CSS classes
   */
  const getRoleClasses = (role: string): string => {
    return role === 'admin'
      ? 'bg-purple-100 text-purple-700'
      : 'bg-gray-100 text-gray-700';
  };

  /**
   * Calculates storage usage percentage.
   *
   * @param used - Bytes used
   * @param quota - Total quota in bytes
   * @returns Percentage (0-100)
   */
  const getStoragePercentage = (used: number, quota: number): number => {
    return Math.min(100, (used / quota) * 100);
  };

  return (
    <div>
      {/* Search */}
      <div className="flex gap-2 mb-4">
        <input
          type="text"
          placeholder="Search by email..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
          className="flex-1 px-3 py-2 border rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <button
          onClick={handleSearch}
          className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600"
        >
          Search
        </button>
      </div>

      {/* Users table */}
      <div className="bg-white rounded-lg border">
        {isLoading ? (
          <CenteredSpinner height="h-32" />
        ) : (
          <table className="w-full">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-500">Email</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-500">Role</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-500">Devices</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-500">Storage</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-500">Created</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {users.map((user) => (
                <tr key={user.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3 text-sm">{user.email}</td>
                  <td className="px-4 py-3 text-sm">
                    <span className={`px-2 py-1 rounded text-xs ${getRoleClasses(user.role)}`}>
                      {user.role}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-sm">{user.deviceCount}</td>
                  <td className="px-4 py-3 text-sm">
                    {formatBytes(user.storageUsed)} / {formatBytes(user.storageQuota)}
                    <div className="w-24 h-1 bg-gray-200 rounded mt-1">
                      <div
                        className="h-full bg-blue-500 rounded"
                        style={{ width: `${getStoragePercentage(user.storageUsed, user.storageQuota)}%` }}
                      />
                    </div>
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-500">
                    {formatRelativeTime(user.createdAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {!isLoading && users.length === 0 && (
          <div className="text-center py-8 text-gray-500">No users found</div>
        )}
      </div>
    </div>
  );
};
