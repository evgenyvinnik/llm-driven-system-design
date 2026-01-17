import { useEffect, useState } from 'react';
import { adminApi } from '../../services/api';
import type { AdminUser } from './types';

/**
 * Users management tab for admin dashboard.
 * Fetches and displays a table of all registered users with their details.
 * Handles its own data loading and loading state.
 *
 * Displays:
 * - User name and email
 * - Role badge (highlighted for admin users)
 * - Subscription tier
 * - Account creation date
 *
 * @returns Table view of all platform users with loading state
 */
export function UsersTab() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const loadUsers = async () => {
      try {
        const data = (await adminApi.getUsers({ limit: 50 })) as {
          users: AdminUser[];
        };
        setUsers(data.users);
      } catch (error) {
        console.error('Failed to load users:', error);
      } finally {
        setIsLoading(false);
      }
    };
    loadUsers();
  }, []);

  if (isLoading) {
    return <LoadingSpinner />;
  }

  return (
    <div className="bg-apple-gray-800 rounded-2xl overflow-hidden">
      <table className="w-full">
        <UsersTableHeader />
        <tbody className="divide-y divide-white/10">
          {users.map((user) => (
            <UserTableRow key={user.id} user={user} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Loading spinner component for users tab.
 * Displayed while user data is being fetched.
 *
 * @returns Centered spinning loader
 */
function LoadingSpinner() {
  return (
    <div className="flex items-center justify-center py-12">
      <div className="animate-spin rounded-full h-8 w-8 border-t-2 border-b-2 border-white"></div>
    </div>
  );
}

/**
 * Table header for users management table.
 * Defines columns: Name, Email, Role, Subscription, Joined.
 *
 * @returns Table header row with styled column headers
 */
function UsersTableHeader() {
  return (
    <thead className="bg-apple-gray-700">
      <tr>
        <th className="px-6 py-4 text-left text-sm font-medium text-white/60">
          Name
        </th>
        <th className="px-6 py-4 text-left text-sm font-medium text-white/60">
          Email
        </th>
        <th className="px-6 py-4 text-left text-sm font-medium text-white/60">
          Role
        </th>
        <th className="px-6 py-4 text-left text-sm font-medium text-white/60">
          Subscription
        </th>
        <th className="px-6 py-4 text-left text-sm font-medium text-white/60">
          Joined
        </th>
      </tr>
    </thead>
  );
}

/**
 * Props for the UserTableRow component.
 */
interface UserTableRowProps {
  /** User data for this row */
  user: AdminUser;
}

/**
 * Individual row in the users table.
 * Displays user details with role badge highlighting for admins.
 *
 * @param props - UserTableRowProps with user data
 * @returns Table row with user information
 */
function UserTableRow({ user }: UserTableRowProps) {
  return (
    <tr className="hover:bg-apple-gray-700">
      <td className="px-6 py-4">{user.name}</td>
      <td className="px-6 py-4">{user.email}</td>
      <td className="px-6 py-4">
        <RoleBadge role={user.role} />
      </td>
      <td className="px-6 py-4 capitalize">{user.subscription_tier}</td>
      <td className="px-6 py-4 text-white/60">
        {new Date(user.created_at).toLocaleDateString()}
      </td>
    </tr>
  );
}

/**
 * Props for the RoleBadge component.
 */
interface RoleBadgeProps {
  /** User role (user or admin) */
  role: string;
}

/**
 * Colored badge for user role display.
 * Admin role is highlighted with blue background.
 *
 * @param props - RoleBadgeProps with role string
 * @returns Styled badge element
 */
function RoleBadge({ role }: RoleBadgeProps) {
  const classes =
    role === 'admin' ? 'bg-apple-blue/20 text-apple-blue' : 'bg-white/10';

  return <span className={`px-2 py-1 text-xs rounded ${classes}`}>{role}</span>;
}
