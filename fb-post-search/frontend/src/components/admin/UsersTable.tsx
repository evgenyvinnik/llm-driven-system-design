/**
 * @fileoverview Users table component for the admin dashboard.
 * Displays a list of registered users with their details.
 */

import type { User } from '../../types';

/**
 * Props for the UsersTable component.
 */
interface UsersTableProps {
  /** Array of users to display */
  users: User[];
}

/**
 * Renders a table of registered users.
 * Shows user avatar, name, username, email, role, and join date.
 *
 * @param props - UsersTable props
 * @returns Table displaying user information
 */
export function UsersTable({ users }: UsersTableProps) {
  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
      <table className="w-full">
        <thead className="bg-gray-50">
          <tr>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
              User
            </th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
              Email
            </th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
              Role
            </th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
              Joined
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-200">
          {users.map((user) => (
            <UserRow key={user.id} user={user} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Props for the UserRow sub-component.
 */
interface UserRowProps {
  /** User to display in the row */
  user: User;
}

/**
 * Renders a single user row in the users table.
 *
 * @param props - UserRow props
 * @returns Table row with user details
 */
function UserRow({ user }: UserRowProps) {
  // User type doesn't include created_at, but it's passed from admin API
  const userWithDate = user as User & { created_at?: string };

  return (
    <tr className="hover:bg-gray-50">
      <td className="px-6 py-4 flex items-center gap-3">
        <div className="w-8 h-8 bg-gradient-to-br from-primary-400 to-primary-600 rounded-full flex items-center justify-center text-white text-sm font-medium">
          {user.display_name.charAt(0).toUpperCase()}
        </div>
        <div>
          <div className="font-medium text-gray-900">{user.display_name}</div>
          <div className="text-sm text-gray-500">@{user.username}</div>
        </div>
      </td>
      <td className="px-6 py-4 text-gray-600">{user.email}</td>
      <td className="px-6 py-4">
        <span
          className={`px-2 py-1 text-xs rounded-full ${
            user.role === 'admin'
              ? 'bg-purple-100 text-purple-700'
              : 'bg-gray-100 text-gray-700'
          }`}
        >
          {user.role}
        </span>
      </td>
      <td className="px-6 py-4 text-gray-600 text-sm">
        {userWithDate.created_at
          ? new Date(userWithDate.created_at).toLocaleDateString()
          : 'N/A'}
      </td>
    </tr>
  );
}
