import { createFileRoute, useNavigate, Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { Header } from '../components';
import { useAuthStore } from '../stores/authStore';
import { adminApi } from '../services/api';
import { Users, Film, Eye, TrendingUp, Star, Settings } from 'lucide-react';

interface AdminStats {
  totalUsers: number;
  totalContent: number;
  totalViews: number;
  activeSubscriptions: Record<string, number>;
}

interface AdminContent {
  id: string;
  title: string;
  content_type: string;
  status: string;
  featured: boolean;
  view_count: number;
  created_at: string;
}

function AdminPage() {
  const navigate = useNavigate();
  const { user } = useAuthStore();
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [content, setContent] = useState<AdminContent[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'overview' | 'content' | 'users'>('overview');

  useEffect(() => {
    if (!user || user.role !== 'admin') {
      navigate({ to: '/' });
      return;
    }

    const loadData = async () => {
      try {
        const [statsData, contentData] = await Promise.all([
          adminApi.getStats() as Promise<AdminStats>,
          adminApi.getContent({ limit: 20 }) as Promise<{ content: AdminContent[] }>,
        ]);
        setStats(statsData);
        setContent(contentData.content);
      } catch (error) {
        console.error('Failed to load admin data:', error);
      } finally {
        setIsLoading(false);
      }
    };
    loadData();
  }, [user, navigate]);

  const handleToggleFeatured = async (contentId: string) => {
    try {
      await adminApi.toggleFeatured(contentId);
      setContent((prev) =>
        prev.map((c) =>
          c.id === contentId ? { ...c, featured: !c.featured } : c
        )
      );
    } catch (error) {
      console.error('Failed to toggle featured:', error);
    }
  };

  if (!user || user.role !== 'admin') {
    return null;
  }

  return (
    <>
      <Header />
      <main className="pt-24 px-8 lg:px-16 pb-16 min-h-screen">
        <div className="flex items-center justify-between mb-8">
          <h1 className="text-3xl font-bold">Admin Dashboard</h1>
          <div className="flex items-center gap-2 px-4 py-2 bg-apple-blue/20 text-apple-blue rounded-lg">
            <Settings className="w-4 h-4" />
            Admin Mode
          </div>
        </div>

        {/* Tabs */}
        <div className="flex gap-4 mb-8 border-b border-white/10">
          <button
            onClick={() => setActiveTab('overview')}
            className={`pb-4 px-2 text-sm font-medium transition-colors ${
              activeTab === 'overview'
                ? 'text-white border-b-2 border-white'
                : 'text-white/60 hover:text-white'
            }`}
          >
            Overview
          </button>
          <button
            onClick={() => setActiveTab('content')}
            className={`pb-4 px-2 text-sm font-medium transition-colors ${
              activeTab === 'content'
                ? 'text-white border-b-2 border-white'
                : 'text-white/60 hover:text-white'
            }`}
          >
            Content
          </button>
          <button
            onClick={() => setActiveTab('users')}
            className={`pb-4 px-2 text-sm font-medium transition-colors ${
              activeTab === 'users'
                ? 'text-white border-b-2 border-white'
                : 'text-white/60 hover:text-white'
            }`}
          >
            Users
          </button>
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center py-24">
            <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-white"></div>
          </div>
        ) : (
          <>
            {/* Overview Tab */}
            {activeTab === 'overview' && stats && (
              <div className="space-y-8">
                {/* Stats cards */}
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
                  <StatCard
                    icon={<Users className="w-6 h-6" />}
                    label="Total Users"
                    value={stats.totalUsers}
                    color="blue"
                  />
                  <StatCard
                    icon={<Film className="w-6 h-6" />}
                    label="Total Content"
                    value={stats.totalContent}
                    color="purple"
                  />
                  <StatCard
                    icon={<Eye className="w-6 h-6" />}
                    label="Total Views"
                    value={stats.totalViews}
                    color="green"
                  />
                  <StatCard
                    icon={<TrendingUp className="w-6 h-6" />}
                    label="Active Subscriptions"
                    value={Object.values(stats.activeSubscriptions).reduce((a, b) => a + b, 0)}
                    color="orange"
                  />
                </div>

                {/* Subscription breakdown */}
                <div className="bg-apple-gray-800 rounded-2xl p-6">
                  <h2 className="text-xl font-semibold mb-4">Subscription Breakdown</h2>
                  <div className="grid grid-cols-2 gap-4">
                    {Object.entries(stats.activeSubscriptions).map(([tier, count]) => (
                      <div key={tier} className="flex items-center justify-between p-4 bg-apple-gray-700 rounded-xl">
                        <span className="capitalize">{tier}</span>
                        <span className="text-2xl font-bold">{count}</span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Recent content */}
                <div className="bg-apple-gray-800 rounded-2xl p-6">
                  <h2 className="text-xl font-semibold mb-4">Recent Content</h2>
                  <div className="space-y-2">
                    {content.slice(0, 5).map((item) => (
                      <div key={item.id} className="flex items-center justify-between p-3 bg-apple-gray-700 rounded-lg">
                        <div>
                          <span className="font-medium">{item.title}</span>
                          <span className="text-sm text-white/60 ml-2 capitalize">({item.content_type})</span>
                        </div>
                        <div className="flex items-center gap-4">
                          <span className="text-sm text-white/60">{item.view_count} views</span>
                          <span className={`px-2 py-1 text-xs rounded ${
                            item.status === 'ready' ? 'bg-apple-green/20 text-apple-green' : 'bg-yellow-500/20 text-yellow-500'
                          }`}>
                            {item.status}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* Content Tab */}
            {activeTab === 'content' && (
              <div className="bg-apple-gray-800 rounded-2xl overflow-hidden">
                <table className="w-full">
                  <thead className="bg-apple-gray-700">
                    <tr>
                      <th className="px-6 py-4 text-left text-sm font-medium text-white/60">Title</th>
                      <th className="px-6 py-4 text-left text-sm font-medium text-white/60">Type</th>
                      <th className="px-6 py-4 text-left text-sm font-medium text-white/60">Status</th>
                      <th className="px-6 py-4 text-left text-sm font-medium text-white/60">Views</th>
                      <th className="px-6 py-4 text-left text-sm font-medium text-white/60">Featured</th>
                      <th className="px-6 py-4 text-left text-sm font-medium text-white/60">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/10">
                    {content.map((item) => (
                      <tr key={item.id} className="hover:bg-apple-gray-700">
                        <td className="px-6 py-4">
                          <Link to="/content/$contentId" params={{ contentId: item.id }} className="hover:text-apple-blue">
                            {item.title}
                          </Link>
                        </td>
                        <td className="px-6 py-4 capitalize">{item.content_type}</td>
                        <td className="px-6 py-4">
                          <span className={`px-2 py-1 text-xs rounded ${
                            item.status === 'ready' ? 'bg-apple-green/20 text-apple-green' : 'bg-yellow-500/20 text-yellow-500'
                          }`}>
                            {item.status}
                          </span>
                        </td>
                        <td className="px-6 py-4">{item.view_count}</td>
                        <td className="px-6 py-4">
                          <button
                            onClick={() => handleToggleFeatured(item.id)}
                            className={`p-2 rounded-lg transition-colors ${
                              item.featured ? 'bg-yellow-500/20 text-yellow-500' : 'bg-white/10 text-white/40'
                            }`}
                          >
                            <Star className={`w-4 h-4 ${item.featured ? 'fill-current' : ''}`} />
                          </button>
                        </td>
                        <td className="px-6 py-4">
                          <Link
                            to="/content/$contentId"
                            params={{ contentId: item.id }}
                            className="text-apple-blue hover:underline text-sm"
                          >
                            View
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* Users Tab */}
            {activeTab === 'users' && <UsersTab />}
          </>
        )}
      </main>
    </>
  );
}

function StatCard({
  icon,
  label,
  value,
  color,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  color: 'blue' | 'purple' | 'green' | 'orange';
}) {
  const colors = {
    blue: 'from-blue-500/20 to-blue-600/20 text-blue-400',
    purple: 'from-purple-500/20 to-purple-600/20 text-purple-400',
    green: 'from-green-500/20 to-green-600/20 text-green-400',
    orange: 'from-orange-500/20 to-orange-600/20 text-orange-400',
  };

  return (
    <div className={`bg-gradient-to-br ${colors[color]} rounded-2xl p-6`}>
      <div className="flex items-center gap-4">
        {icon}
        <div>
          <p className="text-sm text-white/60">{label}</p>
          <p className="text-3xl font-bold">{value.toLocaleString()}</p>
        </div>
      </div>
    </div>
  );
}

interface AdminUser {
  id: string;
  email: string;
  name: string;
  role: string;
  subscription_tier: string;
  created_at: string;
}

function UsersTab() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const loadUsers = async () => {
      try {
        const data = await adminApi.getUsers({ limit: 50 }) as { users: AdminUser[] };
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
    return (
      <div className="flex items-center justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-t-2 border-b-2 border-white"></div>
      </div>
    );
  }

  return (
    <div className="bg-apple-gray-800 rounded-2xl overflow-hidden">
      <table className="w-full">
        <thead className="bg-apple-gray-700">
          <tr>
            <th className="px-6 py-4 text-left text-sm font-medium text-white/60">Name</th>
            <th className="px-6 py-4 text-left text-sm font-medium text-white/60">Email</th>
            <th className="px-6 py-4 text-left text-sm font-medium text-white/60">Role</th>
            <th className="px-6 py-4 text-left text-sm font-medium text-white/60">Subscription</th>
            <th className="px-6 py-4 text-left text-sm font-medium text-white/60">Joined</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-white/10">
          {users.map((user) => (
            <tr key={user.id} className="hover:bg-apple-gray-700">
              <td className="px-6 py-4">{user.name}</td>
              <td className="px-6 py-4">{user.email}</td>
              <td className="px-6 py-4">
                <span className={`px-2 py-1 text-xs rounded ${
                  user.role === 'admin' ? 'bg-apple-blue/20 text-apple-blue' : 'bg-white/10'
                }`}>
                  {user.role}
                </span>
              </td>
              <td className="px-6 py-4 capitalize">{user.subscription_tier}</td>
              <td className="px-6 py-4 text-white/60">
                {new Date(user.created_at).toLocaleDateString()}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export const Route = createFileRoute('/admin')({
  component: AdminPage,
});
