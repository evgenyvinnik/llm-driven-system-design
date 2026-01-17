import React, { useEffect, useState } from 'react';
import { api } from '../services/api';
import type { SystemStats, SyncOperation, Conflict } from '../types';
import { formatBytes, formatRelativeTime } from '../utils/helpers';

/**
 * Props for the StatCard component.
 */
interface StatCardProps {
  /** Title label for the statistic */
  title: string;
  /** Value to display (number or formatted string) */
  value: string | number;
  /** Optional subtitle for additional context */
  subtitle?: string;
  /** Color theme for the card */
  color?: 'blue' | 'green' | 'yellow' | 'red' | 'purple';
}

/**
 * Displays a single statistic in a colored card.
 *
 * Used in the admin dashboard to show key metrics with
 * color-coded backgrounds for quick visual scanning.
 *
 * @param props - Component props
 * @returns Styled statistic card
 */
const StatCard: React.FC<StatCardProps> = ({ title, value, subtitle, color = 'blue' }) => {
  const colorClasses = {
    blue: 'bg-blue-100 text-blue-800',
    green: 'bg-green-100 text-green-800',
    yellow: 'bg-yellow-100 text-yellow-800',
    red: 'bg-red-100 text-red-800',
    purple: 'bg-purple-100 text-purple-800',
  };

  return (
    <div className={`p-4 rounded-lg ${colorClasses[color]}`}>
      <h3 className="text-sm font-medium opacity-75">{title}</h3>
      <p className="text-2xl font-bold mt-1">{value}</p>
      {subtitle && <p className="text-xs opacity-75 mt-1">{subtitle}</p>}
    </div>
  );
};

/**
 * Admin dashboard component for system monitoring and management.
 *
 * Provides administrative functionality including:
 * - **Overview Tab**: System-wide statistics (users, files, photos, devices, sync, storage)
 * - **Operations Tab**: Recent sync operations with status and timing
 * - **Conflicts Tab**: Unresolved file conflicts across all users
 * - **Users Tab**: User list with search and storage usage
 *
 * Also includes maintenance actions:
 * - Cleanup orphaned chunks (storage optimization)
 * - Purge soft-deleted files older than 30 days
 *
 * @returns Admin dashboard with tabbed navigation
 */
export const AdminDashboard: React.FC = () => {
  const [stats, setStats] = useState<SystemStats | null>(null);
  const [operations, setOperations] = useState<SyncOperation[]>([]);
  const [conflicts, setConflicts] = useState<Conflict[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'overview' | 'operations' | 'conflicts' | 'users'>('overview');
  const [isCleaningUp, setIsCleaningUp] = useState(false);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    setIsLoading(true);
    try {
      const [statsData, opsData, conflictsData] = await Promise.all([
        api.getStats(),
        api.getSyncOperations({ limit: 50 }),
        api.getAdminConflicts(),
      ]);

      setStats(statsData);
      setOperations(opsData.operations);
      setConflicts(conflictsData.conflicts);
    } catch (error) {
      console.error('Failed to load admin data:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleCleanupChunks = async () => {
    if (!confirm('Cleanup orphaned chunks? This cannot be undone.')) return;

    setIsCleaningUp(true);
    try {
      const result = await api.cleanupChunks();
      alert(`Cleaned up ${result.chunksRemoved} orphaned chunks`);
      await loadData();
    } catch (error) {
      console.error('Cleanup failed:', error);
      alert('Cleanup failed');
    } finally {
      setIsCleaningUp(false);
    }
  };

  const handlePurgeDeleted = async () => {
    if (!confirm('Permanently delete files that have been in trash for 30+ days?')) return;

    setIsCleaningUp(true);
    try {
      const result = await api.purgeDeleted(30);
      alert(`Purged ${result.filesDeleted} files, removed ${result.chunksRemoved} chunks`);
      await loadData();
    } catch (error) {
      console.error('Purge failed:', error);
      alert('Purge failed');
    } finally {
      setIsCleaningUp(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500" />
      </div>
    );
  }

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">Admin Dashboard</h1>
        <button
          onClick={loadData}
          className="px-3 py-1.5 text-sm bg-gray-100 rounded hover:bg-gray-200"
        >
          Refresh
        </button>
      </div>

      {/* Tabs */}
      <div className="flex gap-4 border-b mb-6">
        {(['overview', 'operations', 'conflicts', 'users'] as const).map((tab) => (
          <button
            key={tab}
            className={`px-4 py-2 -mb-px ${
              activeTab === tab
                ? 'border-b-2 border-blue-500 text-blue-600'
                : 'text-gray-500 hover:text-gray-700'
            }`}
            onClick={() => setActiveTab(tab)}
          >
            {tab.charAt(0).toUpperCase() + tab.slice(1)}
            {tab === 'conflicts' && conflicts.length > 0 && (
              <span className="ml-2 px-2 py-0.5 text-xs bg-red-100 text-red-600 rounded-full">
                {conflicts.length}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Overview Tab */}
      {activeTab === 'overview' && stats && (
        <div className="space-y-6">
          {/* User stats */}
          <section>
            <h2 className="text-lg font-semibold mb-4">Users</h2>
            <div className="grid grid-cols-4 gap-4">
              <StatCard title="Total Users" value={stats.users.total} color="blue" />
              <StatCard title="New (24h)" value={stats.users.new24h} color="green" />
              <StatCard
                title="Storage Used"
                value={formatBytes(stats.users.storageUsed)}
                subtitle={`of ${formatBytes(stats.users.storageQuota)}`}
                color="purple"
              />
              <StatCard
                title="Storage %"
                value={`${Math.round((stats.users.storageUsed / stats.users.storageQuota) * 100)}%`}
                color="yellow"
              />
            </div>
          </section>

          {/* File stats */}
          <section>
            <h2 className="text-lg font-semibold mb-4">Files</h2>
            <div className="grid grid-cols-4 gap-4">
              <StatCard title="Total Files" value={stats.files.total} color="blue" />
              <StatCard title="Folders" value={stats.files.folders} color="blue" />
              <StatCard title="Total Size" value={formatBytes(stats.files.totalSize)} color="purple" />
              <StatCard title="Deleted" value={stats.files.deleted} color="red" />
            </div>
          </section>

          {/* Photo stats */}
          <section>
            <h2 className="text-lg font-semibold mb-4">Photos</h2>
            <div className="grid grid-cols-3 gap-4">
              <StatCard title="Total Photos" value={stats.photos.total} color="blue" />
              <StatCard title="Favorites" value={stats.photos.favorites} color="yellow" />
              <StatCard title="Deleted" value={stats.photos.deleted} color="red" />
            </div>
          </section>

          {/* Device stats */}
          <section>
            <h2 className="text-lg font-semibold mb-4">Devices</h2>
            <div className="grid grid-cols-3 gap-4">
              <StatCard title="Total Devices" value={stats.devices.total} color="blue" />
              <StatCard title="Active (24h)" value={stats.devices.active24h} color="green" />
              <StatCard title="Active (7d)" value={stats.devices.active7d} color="green" />
            </div>
          </section>

          {/* Sync stats */}
          <section>
            <h2 className="text-lg font-semibold mb-4">Sync Operations (24h)</h2>
            <div className="grid grid-cols-4 gap-4">
              <StatCard title="Total" value={stats.sync.operations24h} color="blue" />
              <StatCard title="Completed" value={stats.sync.completed} color="green" />
              <StatCard title="Failed" value={stats.sync.failed} color="red" />
              <StatCard title="Conflicts" value={stats.sync.conflicts} color="yellow" />
            </div>
          </section>

          {/* Chunk stats and maintenance */}
          <section>
            <h2 className="text-lg font-semibold mb-4">Storage Optimization</h2>
            <div className="grid grid-cols-3 gap-4 mb-4">
              <StatCard title="Total Chunks" value={stats.chunks.total} color="blue" />
              <StatCard title="Chunk Storage" value={formatBytes(stats.chunks.storageUsed)} color="purple" />
              <StatCard
                title="Dedup Savings"
                value={formatBytes(stats.chunks.dedupSavings)}
                subtitle="Space saved by deduplication"
                color="green"
              />
            </div>

            <div className="flex gap-4">
              <button
                onClick={handleCleanupChunks}
                disabled={isCleaningUp}
                className="px-4 py-2 bg-gray-100 rounded hover:bg-gray-200 disabled:opacity-50"
              >
                {isCleaningUp ? 'Cleaning...' : 'Cleanup Orphaned Chunks'}
              </button>
              <button
                onClick={handlePurgeDeleted}
                disabled={isCleaningUp}
                className="px-4 py-2 bg-red-100 text-red-700 rounded hover:bg-red-200 disabled:opacity-50"
              >
                {isCleaningUp ? 'Purging...' : 'Purge Deleted Files (30+ days)'}
              </button>
            </div>
          </section>
        </div>
      )}

      {/* Operations Tab */}
      {activeTab === 'operations' && (
        <div className="bg-white rounded-lg border">
          <table className="w-full">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-500">User</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-500">Device</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-500">Operation</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-500">File</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-500">Status</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-500">Time</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {operations.map((op) => (
                <tr key={op.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3 text-sm">{op.userEmail}</td>
                  <td className="px-4 py-3 text-sm">{op.deviceName || '-'}</td>
                  <td className="px-4 py-3 text-sm">
                    <span
                      className={`px-2 py-1 rounded text-xs ${
                        op.operationType === 'create'
                          ? 'bg-green-100 text-green-700'
                          : op.operationType === 'update'
                          ? 'bg-blue-100 text-blue-700'
                          : op.operationType === 'delete'
                          ? 'bg-red-100 text-red-700'
                          : 'bg-yellow-100 text-yellow-700'
                      }`}
                    >
                      {op.operationType}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-sm truncate max-w-xs">{op.fileName || '-'}</td>
                  <td className="px-4 py-3 text-sm">
                    <span
                      className={`px-2 py-1 rounded text-xs ${
                        op.status === 'completed'
                          ? 'bg-green-100 text-green-700'
                          : op.status === 'failed'
                          ? 'bg-red-100 text-red-700'
                          : 'bg-yellow-100 text-yellow-700'
                      }`}
                    >
                      {op.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-500">
                    {formatRelativeTime(op.createdAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {operations.length === 0 && (
            <div className="text-center py-8 text-gray-500">No recent operations</div>
          )}
        </div>
      )}

      {/* Conflicts Tab */}
      {activeTab === 'conflicts' && (
        <div className="bg-white rounded-lg border">
          {conflicts.length === 0 ? (
            <div className="text-center py-8 text-gray-500">No unresolved conflicts</div>
          ) : (
            <table className="w-full">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-3 text-left text-sm font-medium text-gray-500">File</th>
                  <th className="px-4 py-3 text-left text-sm font-medium text-gray-500">User</th>
                  <th className="px-4 py-3 text-left text-sm font-medium text-gray-500">Device</th>
                  <th className="px-4 py-3 text-left text-sm font-medium text-gray-500">Version</th>
                  <th className="px-4 py-3 text-left text-sm font-medium text-gray-500">Created</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {conflicts.map((conflict) => (
                  <tr key={conflict.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3">
                      <div className="text-sm font-medium">{conflict.fileName}</div>
                      <div className="text-xs text-gray-500">{conflict.filePath}</div>
                    </td>
                    <td className="px-4 py-3 text-sm">{(conflict as { userEmail?: string }).userEmail || '-'}</td>
                    <td className="px-4 py-3 text-sm">{conflict.deviceName || '-'}</td>
                    <td className="px-4 py-3 text-sm">v{conflict.versionNumber}</td>
                    <td className="px-4 py-3 text-sm text-gray-500">
                      {formatRelativeTime(conflict.createdAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* Users Tab */}
      {activeTab === 'users' && <UsersList />}
    </div>
  );
};

/**
 * User list component for admin user management.
 *
 * Displays a searchable table of all users with their email, role,
 * device count, storage usage (with visual progress bar), and registration date.
 *
 * @returns Searchable user list table
 */
const UsersList: React.FC = () => {
  const [users, setUsers] = useState<Array<{
    id: string;
    email: string;
    role: string;
    storageQuota: number;
    storageUsed: number;
    deviceCount: number;
    createdAt: string;
  }>>([]);
  const [search, setSearch] = useState('');
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    loadUsers();
  }, []);

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

  const handleSearch = () => {
    loadUsers(search);
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
          <div className="flex justify-center py-8">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500" />
          </div>
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
                    <span
                      className={`px-2 py-1 rounded text-xs ${
                        user.role === 'admin'
                          ? 'bg-purple-100 text-purple-700'
                          : 'bg-gray-100 text-gray-700'
                      }`}
                    >
                      {user.role}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-sm">{user.deviceCount}</td>
                  <td className="px-4 py-3 text-sm">
                    {formatBytes(user.storageUsed)} / {formatBytes(user.storageQuota)}
                    <div className="w-24 h-1 bg-gray-200 rounded mt-1">
                      <div
                        className="h-full bg-blue-500 rounded"
                        style={{
                          width: `${Math.min(100, (user.storageUsed / user.storageQuota) * 100)}%`,
                        }}
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
