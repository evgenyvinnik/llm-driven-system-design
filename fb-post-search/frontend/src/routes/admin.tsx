import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useState, useEffect } from 'react';
import {
  Users,
  FileText,
  Search,
  Database,
  RefreshCw,
  Activity,
  ChevronRight,
  AlertCircle,
  CheckCircle,
} from 'lucide-react';
import { api } from '../services/api';
import { useAuthStore } from '../stores/authStore';
import type { AdminStats, User, Post, SearchHistoryEntry } from '../types';

function AdminPage() {
  const { user, isAuthenticated } = useAuthStore();
  const navigate = useNavigate();

  const [activeTab, setActiveTab] = useState<'overview' | 'users' | 'posts' | 'searches'>('overview');
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [posts, setPosts] = useState<Post[]>([]);
  const [searchHistory, setSearchHistory] = useState<SearchHistoryEntry[]>([]);
  const [health, setHealth] = useState<{
    status: string;
    postgres: boolean;
    elasticsearch: boolean;
    redis: boolean;
  } | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isReindexing, setIsReindexing] = useState(false);

  useEffect(() => {
    if (!isAuthenticated || user?.role !== 'admin') {
      navigate({ to: '/login' });
      return;
    }

    loadData();
  }, [isAuthenticated, user, navigate]);

  const loadData = async () => {
    setIsLoading(true);
    try {
      const [statsData, healthData] = await Promise.all([
        api.getAdminStats(),
        api.getAdminHealth(),
      ]);
      setStats(statsData);
      setHealth(healthData);
    } catch (error) {
      console.error('Failed to load admin data:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const loadUsers = async () => {
    try {
      const { users } = await api.getAdminUsers();
      setUsers(users);
    } catch (error) {
      console.error('Failed to load users:', error);
    }
  };

  const loadPosts = async () => {
    try {
      const { posts } = await api.getAdminPosts();
      setPosts(posts);
    } catch (error) {
      console.error('Failed to load posts:', error);
    }
  };

  const loadSearchHistory = async () => {
    try {
      const { history } = await api.getAdminSearchHistory();
      setSearchHistory(history);
    } catch (error) {
      console.error('Failed to load search history:', error);
    }
  };

  const handleReindex = async () => {
    setIsReindexing(true);
    try {
      const result = await api.reindexPosts();
      alert(`Successfully reindexed ${result.indexed_count} posts`);
      loadData();
    } catch (error) {
      alert('Reindex failed: ' + (error instanceof Error ? error.message : 'Unknown error'));
    } finally {
      setIsReindexing(false);
    }
  };

  useEffect(() => {
    if (activeTab === 'users' && users.length === 0) {
      loadUsers();
    } else if (activeTab === 'posts' && posts.length === 0) {
      loadPosts();
    } else if (activeTab === 'searches' && searchHistory.length === 0) {
      loadSearchHistory();
    }
  }, [activeTab, users.length, posts.length, searchHistory.length]);

  if (isLoading) {
    return (
      <div className="min-h-[calc(100vh-4rem)] flex items-center justify-center">
        <div className="animate-pulse text-gray-500">Loading admin panel...</div>
      </div>
    );
  }

  const formatBytes = (bytes: number) => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-gray-900">Admin Dashboard</h1>
        <p className="text-gray-500">Manage users, posts, and system settings</p>
      </div>

      {/* Health Status */}
      {health && (
        <div className="mb-6 p-4 bg-white rounded-lg shadow-sm border border-gray-200">
          <div className="flex items-center gap-4">
            <Activity className="w-5 h-5 text-gray-500" />
            <span className="font-medium text-gray-700">System Health:</span>
            <div className="flex items-center gap-4">
              <HealthIndicator label="PostgreSQL" status={health.postgres} />
              <HealthIndicator label="Elasticsearch" status={health.elasticsearch} />
              <HealthIndicator label="Redis" status={health.redis} />
            </div>
            <button
              onClick={handleReindex}
              disabled={isReindexing}
              className="ml-auto flex items-center gap-2 px-4 py-2 bg-primary-500 text-white rounded-lg hover:bg-primary-600 disabled:opacity-50"
            >
              <RefreshCw className={`w-4 h-4 ${isReindexing ? 'animate-spin' : ''}`} />
              {isReindexing ? 'Reindexing...' : 'Reindex Posts'}
            </button>
          </div>
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-2 mb-6 border-b border-gray-200">
        {[
          { id: 'overview', label: 'Overview', icon: Database },
          { id: 'users', label: 'Users', icon: Users },
          { id: 'posts', label: 'Posts', icon: FileText },
          { id: 'searches', label: 'Search History', icon: Search },
        ].map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id as typeof activeTab)}
            className={`flex items-center gap-2 px-4 py-3 border-b-2 -mb-px transition-colors ${
              activeTab === tab.id
                ? 'border-primary-500 text-primary-600'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            <tab.icon className="w-4 h-4" />
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab Content */}
      {activeTab === 'overview' && stats && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          <StatCard
            icon={Users}
            label="Total Users"
            value={stats.users.total}
            color="blue"
          />
          <StatCard
            icon={FileText}
            label="Total Posts"
            value={stats.posts.total_posts}
            color="green"
          />
          <StatCard
            icon={FileText}
            label="Posts Today"
            value={stats.posts.posts_today}
            color="orange"
          />
          <StatCard
            icon={Search}
            label="Total Searches"
            value={stats.searches.total}
            color="purple"
          />

          {stats.elasticsearch && (
            <>
              <StatCard
                icon={Database}
                label="Indexed Docs"
                value={stats.elasticsearch.docs_count}
                color="teal"
              />
              <StatCard
                icon={Database}
                label="Index Size"
                value={formatBytes(stats.elasticsearch.store_size_bytes)}
                color="indigo"
              />
            </>
          )}

          {/* Posts by Visibility */}
          <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6 col-span-1 md:col-span-2">
            <h3 className="font-semibold text-gray-900 mb-4">Posts by Visibility</h3>
            <div className="space-y-2">
              {Object.entries(stats.posts.by_visibility).map(([visibility, count]) => (
                <div key={visibility} className="flex items-center justify-between">
                  <span className="capitalize text-gray-600">{visibility}</span>
                  <span className="font-medium text-gray-900">{count}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Posts by Type */}
          <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6 col-span-1 md:col-span-2">
            <h3 className="font-semibold text-gray-900 mb-4">Posts by Type</h3>
            <div className="space-y-2">
              {Object.entries(stats.posts.by_type).map(([type, count]) => (
                <div key={type} className="flex items-center justify-between">
                  <span className="capitalize text-gray-600">{type}</span>
                  <span className="font-medium text-gray-900">{count}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {activeTab === 'users' && (
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
                <tr key={user.id} className="hover:bg-gray-50">
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
                    {new Date(user.created_at!).toLocaleDateString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {activeTab === 'posts' && (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
          <table className="w-full">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                  Author
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                  Content
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                  Type
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                  Visibility
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                  Engagement
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {posts.map((post) => (
                <tr key={post.id} className="hover:bg-gray-50">
                  <td className="px-6 py-4 text-sm text-gray-900">
                    {post.author_name}
                  </td>
                  <td className="px-6 py-4 text-sm text-gray-600 max-w-xs truncate">
                    {post.content}
                  </td>
                  <td className="px-6 py-4">
                    <span className="px-2 py-1 text-xs rounded-full bg-gray-100 text-gray-700 capitalize">
                      {post.post_type}
                    </span>
                  </td>
                  <td className="px-6 py-4">
                    <span className="px-2 py-1 text-xs rounded-full bg-blue-100 text-blue-700 capitalize">
                      {post.visibility}
                    </span>
                  </td>
                  <td className="px-6 py-4 text-sm text-gray-600">
                    {post.like_count} likes, {post.comment_count} comments
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {activeTab === 'searches' && (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
          <table className="w-full">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                  User
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                  Query
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                  Results
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                  Time
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {searchHistory.map((entry) => (
                <tr key={entry.id} className="hover:bg-gray-50">
                  <td className="px-6 py-4 text-sm text-gray-900">
                    @{entry.username}
                  </td>
                  <td className="px-6 py-4 text-sm font-medium text-gray-900">
                    {entry.query}
                  </td>
                  <td className="px-6 py-4 text-sm text-gray-600">
                    {entry.results_count}
                  </td>
                  <td className="px-6 py-4 text-sm text-gray-500">
                    {new Date(entry.created_at).toLocaleString()}
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

function StatCard({
  icon: Icon,
  label,
  value,
  color,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: number | string;
  color: string;
}) {
  const colorClasses: Record<string, string> = {
    blue: 'bg-blue-50 text-blue-600',
    green: 'bg-green-50 text-green-600',
    orange: 'bg-orange-50 text-orange-600',
    purple: 'bg-purple-50 text-purple-600',
    teal: 'bg-teal-50 text-teal-600',
    indigo: 'bg-indigo-50 text-indigo-600',
  };

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
      <div className="flex items-center gap-4">
        <div className={`p-3 rounded-lg ${colorClasses[color]}`}>
          <Icon className="w-6 h-6" />
        </div>
        <div>
          <p className="text-sm text-gray-500">{label}</p>
          <p className="text-2xl font-bold text-gray-900">
            {typeof value === 'number' ? value.toLocaleString() : value}
          </p>
        </div>
        <ChevronRight className="w-5 h-5 text-gray-400 ml-auto" />
      </div>
    </div>
  );
}

function HealthIndicator({ label, status }: { label: string; status: boolean }) {
  return (
    <div className="flex items-center gap-1.5">
      {status ? (
        <CheckCircle className="w-4 h-4 text-green-500" />
      ) : (
        <AlertCircle className="w-4 h-4 text-red-500" />
      )}
      <span className={`text-sm ${status ? 'text-green-600' : 'text-red-600'}`}>
        {label}
      </span>
    </div>
  );
}

export const Route = createFileRoute('/admin')({
  component: AdminPage,
});
