import { useEffect, useState } from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useAuthStore } from '../stores/authStore';
import { Sidebar } from '../components/Sidebar';
import { adminApi } from '../services/api';
import { SystemStats, User } from '../types';
import { Loader2, Users, HardDrive, FileBox, Layers, Trash2, RefreshCw } from 'lucide-react';
import { formatBytes } from '../utils/format';

export const Route = createFileRoute('/admin')({
  component: AdminDashboard,
});

function AdminDashboard() {
  const navigate = useNavigate();
  const { user, isLoading: authLoading, checkAuth } = useAuthStore();
  const [stats, setStats] = useState<SystemStats | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [storageBreakdown, setStorageBreakdown] = useState<Array<{ category: string; count: number; totalSize: number }>>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    checkAuth();
  }, []);

  useEffect(() => {
    if (!authLoading && !user) {
      navigate({ to: '/login' });
    } else if (user && user.role !== 'admin') {
      navigate({ to: '/' });
    }
  }, [authLoading, user, navigate]);

  useEffect(() => {
    if (user && user.role === 'admin') {
      loadData();
    }
  }, [user]);

  const loadData = async () => {
    setIsLoading(true);
    setError('');

    try {
      const [statsData, usersData, breakdownData] = await Promise.all([
        adminApi.getStats(),
        adminApi.getUsers(),
        adminApi.getStorageBreakdown(),
      ]);
      setStats(statsData);
      setUsers(usersData);
      setStorageBreakdown(breakdownData);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsLoading(false);
    }
  };

  const handleCleanup = async () => {
    if (!confirm('Run storage cleanup to remove orphaned chunks?')) return;

    try {
      const result = await adminApi.runCleanup();
      alert(`Cleanup completed. Deleted ${result.deletedChunks} orphaned chunks.`);
      loadData();
    } catch (err) {
      alert('Cleanup failed: ' + (err as Error).message);
    }
  };

  const handleDeleteUser = async (userId: string) => {
    if (!confirm('Are you sure you want to delete this user? This will delete all their files.')) return;

    try {
      await adminApi.deleteUser(userId);
      loadData();
    } catch (err) {
      alert('Delete failed: ' + (err as Error).message);
    }
  };

  if (authLoading) {
    return (
      <div className="h-screen flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-dropbox-blue" />
      </div>
    );
  }

  if (!user || user.role !== 'admin') {
    return null;
  }

  return (
    <div className="h-screen flex bg-gray-50">
      <Sidebar />

      <main className="flex-1 overflow-y-auto">
        <div className="p-6">
          <div className="flex items-center justify-between mb-6">
            <h1 className="text-2xl font-semibold text-gray-900">Admin Dashboard</h1>
            <div className="flex gap-3">
              <button
                onClick={loadData}
                className="flex items-center gap-2 px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
              >
                <RefreshCw size={16} />
                Refresh
              </button>
              <button
                onClick={handleCleanup}
                className="flex items-center gap-2 px-4 py-2 bg-red-50 text-red-600 hover:bg-red-100 rounded-lg transition-colors"
              >
                <Trash2 size={16} />
                Cleanup
              </button>
            </div>
          </div>

          {isLoading ? (
            <div className="flex items-center justify-center p-8">
              <Loader2 className="w-8 h-8 animate-spin text-dropbox-blue" />
            </div>
          ) : error ? (
            <div className="p-8 text-center text-red-500">{error}</div>
          ) : (
            <>
              {/* Stats cards */}
              {stats && (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
                  <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
                    <div className="flex items-center gap-4">
                      <div className="p-3 bg-blue-100 rounded-lg">
                        <Users className="text-dropbox-blue" size={24} />
                      </div>
                      <div>
                        <p className="text-2xl font-semibold">{stats.totalUsers}</p>
                        <p className="text-sm text-gray-500">Total Users</p>
                      </div>
                    </div>
                  </div>

                  <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
                    <div className="flex items-center gap-4">
                      <div className="p-3 bg-green-100 rounded-lg">
                        <FileBox className="text-green-600" size={24} />
                      </div>
                      <div>
                        <p className="text-2xl font-semibold">{stats.totalFiles}</p>
                        <p className="text-sm text-gray-500">Total Files</p>
                      </div>
                    </div>
                  </div>

                  <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
                    <div className="flex items-center gap-4">
                      <div className="p-3 bg-purple-100 rounded-lg">
                        <HardDrive className="text-purple-600" size={24} />
                      </div>
                      <div>
                        <p className="text-2xl font-semibold">{formatBytes(stats.totalStorage)}</p>
                        <p className="text-sm text-gray-500">Total Storage</p>
                      </div>
                    </div>
                  </div>

                  <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
                    <div className="flex items-center gap-4">
                      <div className="p-3 bg-orange-100 rounded-lg">
                        <Layers className="text-orange-600" size={24} />
                      </div>
                      <div>
                        <p className="text-2xl font-semibold">{(stats.deduplicationRatio * 100).toFixed(0)}%</p>
                        <p className="text-sm text-gray-500">Dedup Ratio</p>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* Storage saved */}
              {stats && stats.storageSaved > 0 && (
                <div className="bg-green-50 border border-green-200 rounded-lg p-4 mb-8">
                  <p className="text-green-700">
                    <span className="font-semibold">{formatBytes(stats.storageSaved)}</span> saved through deduplication
                    (logical: {formatBytes(stats.logicalStorageUsed)}, actual: {formatBytes(stats.actualStorageUsed)})
                  </p>
                </div>
              )}

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                {/* Users table */}
                <div className="bg-white rounded-lg shadow-sm border border-gray-200">
                  <div className="px-6 py-4 border-b border-gray-200">
                    <h2 className="text-lg font-medium">Users</h2>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full">
                      <thead className="bg-gray-50">
                        <tr>
                          <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">User</th>
                          <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Storage</th>
                          <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Role</th>
                          <th className="px-6 py-3"></th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100">
                        {users.map((u) => (
                          <tr key={u.id} className="hover:bg-gray-50">
                            <td className="px-6 py-4">
                              <p className="font-medium text-gray-900">{u.name}</p>
                              <p className="text-sm text-gray-500">{u.email}</p>
                            </td>
                            <td className="px-6 py-4 text-sm text-gray-600">
                              {formatBytes(u.usedBytes)} / {formatBytes(u.quotaBytes)}
                            </td>
                            <td className="px-6 py-4">
                              <span className={`px-2 py-1 text-xs rounded ${
                                u.role === 'admin' ? 'bg-purple-100 text-purple-700' : 'bg-gray-100 text-gray-700'
                              }`}>
                                {u.role}
                              </span>
                            </td>
                            <td className="px-6 py-4">
                              {u.id !== user.id && (
                                <button
                                  onClick={() => handleDeleteUser(u.id)}
                                  className="text-red-600 hover:text-red-800"
                                >
                                  <Trash2 size={16} />
                                </button>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* Storage breakdown */}
                <div className="bg-white rounded-lg shadow-sm border border-gray-200">
                  <div className="px-6 py-4 border-b border-gray-200">
                    <h2 className="text-lg font-medium">Storage by Type</h2>
                  </div>
                  <div className="p-6">
                    {storageBreakdown.length === 0 ? (
                      <p className="text-gray-500 text-center py-4">No files uploaded yet</p>
                    ) : (
                      <div className="space-y-4">
                        {storageBreakdown.map((item) => {
                          const totalSize = storageBreakdown.reduce((sum, i) => sum + Number(i.totalSize), 0);
                          const percentage = totalSize > 0 ? (Number(item.totalSize) / totalSize) * 100 : 0;

                          return (
                            <div key={item.category}>
                              <div className="flex justify-between mb-1">
                                <span className="text-sm font-medium text-gray-700">{item.category}</span>
                                <span className="text-sm text-gray-500">
                                  {item.count} files - {formatBytes(Number(item.totalSize))}
                                </span>
                              </div>
                              <div className="w-full h-2 bg-gray-200 rounded-full overflow-hidden">
                                <div
                                  className="h-full bg-dropbox-blue"
                                  style={{ width: `${percentage}%` }}
                                />
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
