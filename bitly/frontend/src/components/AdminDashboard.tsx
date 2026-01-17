import React, { useEffect, useState } from 'react';
import { SystemStats, GlobalAnalytics, KeyPoolStats, Url, User } from '../types';
import { api } from '../services/api';

function StatCard({ title, value, subtitle }: { title: string; value: number | string; subtitle?: string }) {
  return (
    <div className="card bg-gray-50">
      <p className="text-3xl font-bold text-primary-600">{value.toLocaleString()}</p>
      <p className="text-sm font-medium text-gray-900">{title}</p>
      {subtitle && <p className="text-xs text-gray-500">{subtitle}</p>}
    </div>
  );
}

function StatsSection() {
  const [stats, setStats] = useState<SystemStats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function loadStats() {
      try {
        const data = await api.admin.getStats();
        setStats(data);
      } catch (err) {
        console.error('Failed to load stats:', err);
      } finally {
        setLoading(false);
      }
    }
    loadStats();
  }, []);

  if (loading) return <p className="text-gray-600">Loading stats...</p>;
  if (!stats) return <p className="text-red-600">Failed to load stats</p>;

  return (
    <div className="space-y-6">
      <h2 className="text-xl font-bold">System Overview</h2>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard title="Total URLs" value={stats.total_urls} />
        <StatCard title="Active URLs" value={stats.active_urls} />
        <StatCard title="Total Clicks" value={stats.total_clicks} />
        <StatCard title="Clicks Today" value={stats.clicks_today} />
        <StatCard title="URLs Today" value={stats.urls_created_today} />
        <StatCard title="Keys Available" value={stats.keys_available} />
        <StatCard title="Keys Used" value={stats.keys_used} />
      </div>

      {stats.top_urls.length > 0 && (
        <div>
          <h3 className="text-lg font-semibold mb-3">Top URLs by Clicks</h3>
          <div className="card">
            <table className="w-full">
              <thead>
                <tr className="text-left text-sm text-gray-600">
                  <th className="pb-2">Short Code</th>
                  <th className="pb-2">URL</th>
                  <th className="pb-2 text-right">Clicks</th>
                </tr>
              </thead>
              <tbody>
                {stats.top_urls.map((url) => (
                  <tr key={url.short_code} className="border-t border-gray-100">
                    <td className="py-2 font-medium">{url.short_code}</td>
                    <td className="py-2 text-gray-600 truncate max-w-xs">{url.long_url}</td>
                    <td className="py-2 text-right">{url.click_count.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function KeyPoolSection() {
  const [stats, setStats] = useState<KeyPoolStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [repopulating, setRepopulating] = useState(false);

  const loadStats = async () => {
    setLoading(true);
    try {
      const data = await api.admin.getKeyPoolStats();
      setStats(data);
    } catch (err) {
      console.error('Failed to load key pool stats:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadStats();
  }, []);

  const handleRepopulate = async () => {
    setRepopulating(true);
    try {
      await api.admin.repopulateKeyPool(1000);
      await loadStats();
    } catch (err) {
      console.error('Failed to repopulate:', err);
    } finally {
      setRepopulating(false);
    }
  };

  if (loading && !stats) return <p className="text-gray-600">Loading key pool stats...</p>;

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-bold">Key Pool Management</h2>
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <StatCard title="Total Keys" value={stats.total} />
          <StatCard title="Available" value={stats.available} />
          <StatCard title="Allocated" value={stats.allocated} />
          <StatCard title="Used" value={stats.used} />
        </div>
      )}
      <div className="flex gap-4">
        <button
          onClick={handleRepopulate}
          disabled={repopulating}
          className="btn btn-primary"
        >
          {repopulating ? 'Adding keys...' : 'Add 1000 Keys'}
        </button>
        <button onClick={loadStats} disabled={loading} className="btn btn-secondary">
          Refresh
        </button>
      </div>
    </div>
  );
}

function UrlsSection() {
  const [urls, setUrls] = useState<Url[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');

  const loadUrls = async (searchTerm = '') => {
    setLoading(true);
    try {
      const data = await api.admin.getUrls(50, 0, { search: searchTerm || undefined });
      setUrls(data.urls);
      setTotal(data.total);
    } catch (err) {
      console.error('Failed to load URLs:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadUrls();
  }, []);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    loadUrls(search);
  };

  const handleToggleActive = async (shortCode: string, isActive: boolean) => {
    try {
      if (isActive) {
        await api.admin.deactivateUrl(shortCode);
      } else {
        await api.admin.reactivateUrl(shortCode);
      }
      loadUrls(search);
    } catch (err) {
      console.error('Failed to toggle URL:', err);
    }
  };

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-bold">URL Management ({total})</h2>

      <form onSubmit={handleSearch} className="flex gap-2">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by short code or URL..."
          className="input flex-1"
        />
        <button type="submit" className="btn btn-primary">
          Search
        </button>
      </form>

      {loading ? (
        <p className="text-gray-600">Loading URLs...</p>
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="text-left text-sm text-gray-600">
                <th className="pb-2">Short Code</th>
                <th className="pb-2">Long URL</th>
                <th className="pb-2">Clicks</th>
                <th className="pb-2">Status</th>
                <th className="pb-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {urls.map((url) => (
                <tr key={url.short_code} className="border-t border-gray-100">
                  <td className="py-2 font-medium">{url.short_code}</td>
                  <td className="py-2 text-gray-600 truncate max-w-xs">{url.long_url}</td>
                  <td className="py-2">{url.click_count}</td>
                  <td className="py-2">
                    <span
                      className={`text-xs px-2 py-0.5 rounded ${
                        url.is_active
                          ? 'bg-green-100 text-green-800'
                          : 'bg-red-100 text-red-800'
                      }`}
                    >
                      {url.is_active ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                  <td className="py-2">
                    <button
                      onClick={() => handleToggleActive(url.short_code, url.is_active)}
                      className="text-sm text-primary-600 hover:underline"
                    >
                      {url.is_active ? 'Deactivate' : 'Reactivate'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function UsersSection() {
  const [users, setUsers] = useState<User[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);

  const loadUsers = async () => {
    setLoading(true);
    try {
      const data = await api.admin.getUsers();
      setUsers(data.users);
      setTotal(data.total);
    } catch (err) {
      console.error('Failed to load users:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadUsers();
  }, []);

  const handleRoleChange = async (userId: string, newRole: 'user' | 'admin') => {
    try {
      await api.admin.updateUserRole(userId, newRole);
      loadUsers();
    } catch (err) {
      console.error('Failed to update role:', err);
    }
  };

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-bold">User Management ({total})</h2>

      {loading ? (
        <p className="text-gray-600">Loading users...</p>
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="text-left text-sm text-gray-600">
                <th className="pb-2">Email</th>
                <th className="pb-2">Role</th>
                <th className="pb-2">Created</th>
                <th className="pb-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <tr key={user.id} className="border-t border-gray-100">
                  <td className="py-2 font-medium">{user.email}</td>
                  <td className="py-2">
                    <span
                      className={`text-xs px-2 py-0.5 rounded ${
                        user.role === 'admin'
                          ? 'bg-primary-100 text-primary-800'
                          : 'bg-gray-100 text-gray-800'
                      }`}
                    >
                      {user.role}
                    </span>
                  </td>
                  <td className="py-2 text-gray-600">
                    {new Date(user.created_at).toLocaleDateString()}
                  </td>
                  <td className="py-2">
                    <select
                      value={user.role}
                      onChange={(e) => handleRoleChange(user.id, e.target.value as 'user' | 'admin')}
                      className="text-sm border rounded px-2 py-1"
                    >
                      <option value="user">User</option>
                      <option value="admin">Admin</option>
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function AdminDashboard() {
  const [activeTab, setActiveTab] = useState<'stats' | 'urls' | 'users' | 'keys'>('stats');

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Admin Dashboard</h1>

      <div className="flex gap-2 border-b border-gray-200">
        {(['stats', 'urls', 'users', 'keys'] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-4 py-2 font-medium capitalize ${
              activeTab === tab
                ? 'text-primary-600 border-b-2 border-primary-600'
                : 'text-gray-600 hover:text-gray-900'
            }`}
          >
            {tab}
          </button>
        ))}
      </div>

      {activeTab === 'stats' && <StatsSection />}
      {activeTab === 'urls' && <UrlsSection />}
      {activeTab === 'users' && <UsersSection />}
      {activeTab === 'keys' && <KeyPoolSection />}
    </div>
  );
}
