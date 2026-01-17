import { createFileRoute, Navigate, Link } from '@tanstack/react-router';
import { useAuthStore } from '../../stores/authStore';
import { useState, useEffect } from 'react';
import { adminApi } from '../../services/api';
import type { User } from '../../types';
import ReignsAvatar from '../../components/ReignsAvatar';

function AdminUsersPage() {
  const { isAuthenticated, user: currentUser } = useAuthStore();
  const [users, setUsers] = useState<User[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const limit = 20;

  useEffect(() => {
    if (isAuthenticated && currentUser?.is_admin) {
      loadUsers();
    }
  }, [isAuthenticated, currentUser, offset]);

  const loadUsers = async () => {
    setIsLoading(true);
    try {
      const data = await adminApi.getUsers(limit, offset);
      setUsers(data.users);
      setTotal(data.total);
    } catch (error) {
      console.error('Failed to load users:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleBan = async (userId: string) => {
    if (!window.confirm('Are you sure you want to ban this user?')) return;
    try {
      await adminApi.banUser(userId);
      loadUsers();
    } catch (error) {
      console.error('Failed to ban user:', error);
    }
  };

  const handleDelete = async (userId: string) => {
    if (!window.confirm('Are you sure you want to DELETE this user? This cannot be undone.')) {
      return;
    }
    try {
      await adminApi.deleteUser(userId);
      loadUsers();
    } catch (error) {
      console.error('Failed to delete user:', error);
    }
  };

  if (!isAuthenticated) {
    return <Navigate to="/login" />;
  }

  if (!currentUser?.is_admin) {
    return <Navigate to="/" />;
  }

  return (
    <div className="min-h-screen bg-gray-100">
      {/* Header */}
      <header className="bg-white shadow-sm px-4 py-3 flex items-center">
        <Link to="/admin" className="mr-3">
          <svg className="w-6 h-6 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </Link>
        <h1 className="text-xl font-bold flex-1">User Management</h1>
        <span className="text-sm text-gray-500">{total} users</span>
      </header>

      {/* Content */}
      <main className="p-4">
        {isLoading ? (
          <div className="flex items-center justify-center h-64">
            <div className="w-8 h-8 border-4 border-gradient-start border-t-transparent rounded-full animate-spin" />
          </div>
        ) : (
          <>
            <div className="card divide-y">
              {users.map((user) => (
                <div key={user.id} className="p-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="w-12 h-12 rounded-full overflow-hidden bg-gray-800">
                        <ReignsAvatar
                          seed={`${user.id}-${user.name}`}
                          size={48}
                        />
                      </div>
                      <div>
                        <p className="font-medium">{user.name}</p>
                        <p className="text-sm text-gray-500">{user.email}</p>
                        <div className="flex items-center gap-2 mt-1">
                          <span
                            className={`text-xs px-2 py-0.5 rounded-full ${
                              user.gender === 'male'
                                ? 'bg-blue-100 text-blue-700'
                                : 'bg-pink-100 text-pink-700'
                            }`}
                          >
                            {user.gender}
                          </span>
                          {user.is_admin && (
                            <span className="text-xs px-2 py-0.5 rounded-full bg-purple-100 text-purple-700">
                              Admin
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                    {user.id !== currentUser.id && !user.is_admin && (
                      <div className="flex gap-2">
                        <button
                          onClick={() => handleBan(user.id)}
                          className="text-sm text-orange-600 hover:underline"
                        >
                          Ban
                        </button>
                        <button
                          onClick={() => handleDelete(user.id)}
                          className="text-sm text-red-600 hover:underline"
                        >
                          Delete
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>

            {/* Pagination */}
            <div className="flex items-center justify-between mt-4">
              <button
                onClick={() => setOffset(Math.max(0, offset - limit))}
                disabled={offset === 0}
                className="btn btn-secondary disabled:opacity-50"
              >
                Previous
              </button>
              <span className="text-sm text-gray-500">
                {offset + 1} - {Math.min(offset + limit, total)} of {total}
              </span>
              <button
                onClick={() => setOffset(offset + limit)}
                disabled={offset + limit >= total}
                className="btn btn-secondary disabled:opacity-50"
              >
                Next
              </button>
            </div>
          </>
        )}
      </main>
    </div>
  );
}

export const Route = createFileRoute('/admin/users')({
  component: AdminUsersPage,
});
