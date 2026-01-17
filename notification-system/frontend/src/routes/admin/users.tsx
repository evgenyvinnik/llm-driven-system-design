import { createFileRoute } from '@tanstack/react-router';
import { useEffect } from 'react';
import { useAdminStore } from '../../stores/adminStore';

interface User {
  id: string;
  email: string;
  name: string;
  phone: string | null;
  role: string;
  email_verified: boolean;
  phone_verified: boolean;
  created_at: string;
}

function UsersPage() {
  const { users, isLoading, fetchUsers, updateUserRole, resetUserRateLimit } = useAdminStore();

  useEffect(() => {
    fetchUsers();
  }, [fetchUsers]);

  const handleRoleChange = async (userId: string, newRole: string) => {
    if (confirm(`Are you sure you want to change this user's role to ${newRole}?`)) {
      await updateUserRole(userId, newRole);
    }
  };

  const handleResetRateLimit = async (userId: string) => {
    await resetUserRateLimit(userId);
    alert('Rate limits reset successfully');
  };

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h2 className="text-lg font-semibold">Users</h2>
      </div>

      <div className="bg-white rounded-lg shadow overflow-hidden">
        {isLoading && users.length === 0 ? (
          <div className="px-6 py-8 text-center text-gray-500">Loading...</div>
        ) : users.length === 0 ? (
          <div className="px-6 py-8 text-center text-gray-500">No users found</div>
        ) : (
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  User
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Contact
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Role
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Verified
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {users.map((user: unknown) => {
                const u = user as User;
                return (
                  <tr key={u.id}>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="text-sm font-medium text-gray-900">{u.name}</div>
                      <div className="text-xs text-gray-400 font-mono">{u.id.substring(0, 8)}...</div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="text-sm text-gray-900">{u.email}</div>
                      {u.phone && <div className="text-sm text-gray-500">{u.phone}</div>}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <select
                        value={u.role}
                        onChange={(e) => handleRoleChange(u.id, e.target.value)}
                        className="text-sm border border-gray-300 rounded px-2 py-1"
                      >
                        <option value="user">User</option>
                        <option value="admin">Admin</option>
                      </select>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="flex space-x-2">
                        <span
                          className={`px-2 py-1 text-xs rounded ${
                            u.email_verified
                              ? 'bg-green-100 text-green-800'
                              : 'bg-gray-100 text-gray-500'
                          }`}
                        >
                          Email
                        </span>
                        {u.phone && (
                          <span
                            className={`px-2 py-1 text-xs rounded ${
                              u.phone_verified
                                ? 'bg-green-100 text-green-800'
                                : 'bg-gray-100 text-gray-500'
                            }`}
                          >
                            Phone
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm">
                      <button
                        onClick={() => handleResetRateLimit(u.id)}
                        className="text-indigo-600 hover:text-indigo-900"
                      >
                        Reset Rate Limit
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

export const Route = createFileRoute('/admin/users')({
  component: UsersPage,
});
