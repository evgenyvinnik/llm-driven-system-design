import { Link } from '@tanstack/react-router';
import { Search } from 'lucide-react';
import { SearchInput } from './AdminTabs';
import type { User } from '../../types';

/**
 * Props for the UsersTab component.
 */
interface UsersTabProps {
  /** Array of users to display */
  users: User[];
  /** Current search query */
  searchQuery: string;
  /** Callback when search query changes */
  onSearchChange: (query: string) => void;
  /** Callback when user role is updated */
  onUpdateRole: (userId: string, role: string) => void;
}

/**
 * UsersTab displays a searchable table of users with role management.
 *
 * @param props - Component properties
 * @returns Users tab content
 */
export function UsersTab({ users, searchQuery, onSearchChange, onUpdateRole }: UsersTabProps) {
  /**
   * Filters users based on search query matching name or email.
   */
  const filteredUsers = users.filter(
    (u) =>
      !searchQuery ||
      u.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      u.email.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <div>
      <SearchInput
        value={searchQuery}
        onChange={onSearchChange}
        placeholder="Search users..."
        icon={Search}
      />

      <div className="bg-white rounded-lg shadow overflow-hidden">
        <table className="w-full">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-6 py-3 text-left text-sm font-medium text-gray-600">Name</th>
              <th className="px-6 py-3 text-left text-sm font-medium text-gray-600">Email</th>
              <th className="px-6 py-3 text-left text-sm font-medium text-gray-600">Role</th>
              <th className="px-6 py-3 text-left text-sm font-medium text-gray-600">Reviews</th>
              <th className="px-6 py-3 text-left text-sm font-medium text-gray-600">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {filteredUsers.map((user) => (
              <UserRow
                key={user.id}
                user={user}
                onUpdateRole={(role) => onUpdateRole(user.id, role)}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * Props for the UserRow component.
 */
interface UserRowProps {
  /** User data */
  user: User;
  /** Callback when role is changed */
  onUpdateRole: (role: string) => void;
}

/**
 * UserRow displays a single user row in the users table.
 *
 * @param props - Component properties
 * @returns Table row for a user
 */
function UserRow({ user, onUpdateRole }: UserRowProps) {
  return (
    <tr>
      <td className="px-6 py-4 text-gray-900">{user.name}</td>
      <td className="px-6 py-4 text-gray-600">{user.email}</td>
      <td className="px-6 py-4">
        <select
          value={user.role}
          onChange={(e) => onUpdateRole(e.target.value)}
          className="input-field py-1 px-2"
        >
          <option value="user">User</option>
          <option value="business_owner">Business Owner</option>
          <option value="admin">Admin</option>
        </select>
      </td>
      <td className="px-6 py-4 text-gray-600">{user.review_count}</td>
      <td className="px-6 py-4">
        <Link
          to="/users/$id"
          params={{ id: user.id }}
          className="text-yelp-blue hover:underline"
        >
          View
        </Link>
      </td>
    </tr>
  );
}
