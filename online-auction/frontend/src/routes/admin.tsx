import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useState, useEffect } from 'react';
import { useAuthStore } from '../stores/authStore';
import { api } from '../services/api';
import type { Auction, User } from '../types';

export const Route = createFileRoute('/admin')({
  component: AdminPage,
});

interface AdminStats {
  users: number;
  auctions: number;
  bids: number;
  activeAuctions: number;
  websocket: {
    connectedClients: number;
    totalSubscriptions: number;
    activeAuctions: number;
  };
}

function AdminPage() {
  const navigate = useNavigate();
  const { user, isAuthenticated } = useAuthStore();

  const [stats, setStats] = useState<AdminStats | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [auctions, setAuctions] = useState<Auction[]>([]);
  const [activeTab, setActiveTab] = useState<'overview' | 'users' | 'auctions'>('overview');
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (!isAuthenticated || user?.role !== 'admin') {
      navigate({ to: '/' });
      return;
    }

    const fetchData = async () => {
      setIsLoading(true);
      try {
        const [statsData, usersData, auctionsData] = await Promise.all([
          api.getAdminStats(),
          api.getAdminUsers({ limit: 50 }),
          api.getAuctions({ limit: 50, status: 'all' }),
        ]);
        setStats(statsData);
        setUsers(usersData.users);
        setAuctions(auctionsData.auctions);
      } catch (err) {
        console.error('Failed to fetch admin data:', err);
      } finally {
        setIsLoading(false);
      }
    };

    fetchData();
  }, [isAuthenticated, user, navigate]);

  const handleRoleChange = async (userId: string, newRole: 'user' | 'admin') => {
    try {
      const result = await api.updateUserRole(userId, newRole);
      setUsers((prev) =>
        prev.map((u) => (u.id === userId ? result.user : u))
      );
    } catch (err) {
      console.error('Failed to update user role:', err);
    }
  };

  const handleForceClose = async (auctionId: string) => {
    if (!confirm('Are you sure you want to force close this auction?')) {
      return;
    }

    try {
      await api.forceCloseAuction(auctionId);
      setAuctions((prev) =>
        prev.map((a) =>
          a.id === auctionId ? { ...a, status: 'ended' as const } : a
        )
      );
    } catch (err) {
      console.error('Failed to close auction:', err);
    }
  };

  if (!isAuthenticated || user?.role !== 'admin') {
    return null;
  }

  if (isLoading) {
    return (
      <div className="max-w-7xl mx-auto px-4 py-12 text-center">
        <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600"></div>
        <p className="mt-2 text-gray-600">Loading...</p>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <h1 className="text-3xl font-bold text-gray-900 mb-8">Admin Dashboard</h1>

      {/* Tabs */}
      <div className="border-b border-gray-200 mb-8">
        <nav className="-mb-px flex space-x-8">
          {(['overview', 'users', 'auctions'] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`py-4 px-1 border-b-2 font-medium text-sm capitalize ${
                activeTab === tab
                  ? 'border-primary-500 text-primary-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              {tab}
            </button>
          ))}
        </nav>
      </div>

      {/* Overview Tab */}
      {activeTab === 'overview' && stats && (
        <div className="space-y-8">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
            <div className="bg-white rounded-lg shadow-md p-6">
              <p className="text-sm text-gray-500">Total Users</p>
              <p className="text-3xl font-bold text-gray-900">{stats.users}</p>
            </div>
            <div className="bg-white rounded-lg shadow-md p-6">
              <p className="text-sm text-gray-500">Total Auctions</p>
              <p className="text-3xl font-bold text-gray-900">{stats.auctions}</p>
            </div>
            <div className="bg-white rounded-lg shadow-md p-6">
              <p className="text-sm text-gray-500">Active Auctions</p>
              <p className="text-3xl font-bold text-green-600">{stats.activeAuctions}</p>
            </div>
            <div className="bg-white rounded-lg shadow-md p-6">
              <p className="text-sm text-gray-500">Total Bids</p>
              <p className="text-3xl font-bold text-gray-900">{stats.bids}</p>
            </div>
          </div>

          <div className="bg-white rounded-lg shadow-md p-6">
            <h2 className="text-lg font-semibold mb-4">WebSocket Status</h2>
            <div className="grid grid-cols-3 gap-4">
              <div>
                <p className="text-sm text-gray-500">Connected Clients</p>
                <p className="text-2xl font-bold text-gray-900">
                  {stats.websocket.connectedClients}
                </p>
              </div>
              <div>
                <p className="text-sm text-gray-500">Active Subscriptions</p>
                <p className="text-2xl font-bold text-gray-900">
                  {stats.websocket.totalSubscriptions}
                </p>
              </div>
              <div>
                <p className="text-sm text-gray-500">Watched Auctions</p>
                <p className="text-2xl font-bold text-gray-900">
                  {stats.websocket.activeAuctions}
                </p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Users Tab */}
      {activeTab === 'users' && (
        <div className="bg-white rounded-lg shadow-md overflow-hidden">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  User
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Email
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Role
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {users.map((u) => (
                <tr key={u.id}>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div className="flex items-center">
                      <div className="w-8 h-8 bg-primary-100 rounded-full flex items-center justify-center">
                        <span className="text-primary-600 font-medium">
                          {u.username.charAt(0).toUpperCase()}
                        </span>
                      </div>
                      <span className="ml-3 font-medium text-gray-900">{u.username}</span>
                    </div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-gray-500">{u.email}</td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <span
                      className={`px-2 py-1 text-xs rounded-full ${
                        u.role === 'admin'
                          ? 'bg-purple-100 text-purple-800'
                          : 'bg-gray-100 text-gray-800'
                      }`}
                    >
                      {u.role}
                    </span>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    {u.id !== user?.id && (
                      <button
                        onClick={() =>
                          handleRoleChange(u.id, u.role === 'admin' ? 'user' : 'admin')
                        }
                        className="text-primary-600 hover:text-primary-700 text-sm"
                      >
                        {u.role === 'admin' ? 'Remove Admin' : 'Make Admin'}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Auctions Tab */}
      {activeTab === 'auctions' && (
        <div className="bg-white rounded-lg shadow-md overflow-hidden">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Auction
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Seller
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Current Price
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Status
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {auctions.map((auction) => (
                <tr key={auction.id}>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <a
                      href={`/auction/${auction.id}`}
                      className="font-medium text-gray-900 hover:text-primary-600"
                    >
                      {auction.title}
                    </a>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-gray-500">
                    {auction.seller_name}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-gray-900">
                    ${parseFloat(auction.current_price).toFixed(2)}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <span
                      className={`px-2 py-1 text-xs rounded-full ${
                        auction.status === 'active'
                          ? 'bg-green-100 text-green-800'
                          : auction.status === 'ended'
                            ? 'bg-gray-100 text-gray-800'
                            : 'bg-red-100 text-red-800'
                      }`}
                    >
                      {auction.status}
                    </span>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    {auction.status === 'active' && (
                      <button
                        onClick={() => handleForceClose(auction.id)}
                        className="text-red-600 hover:text-red-700 text-sm"
                      >
                        Force Close
                      </button>
                    )}
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
