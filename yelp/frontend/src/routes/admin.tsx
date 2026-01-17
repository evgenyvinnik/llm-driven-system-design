import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useState, useEffect } from 'react';
import {
  Store,
  Users,
  MessageSquare,
  TrendingUp,
  CheckCircle,
  XCircle,
  Search,
} from 'lucide-react';
import { useAuthStore } from '../stores/authStore';
import api from '../services/api';
import type { AdminStats, User, Business, Review, Pagination } from '../types';

export const Route = createFileRoute('/admin')({
  component: AdminPage,
});

function AdminPage() {
  const navigate = useNavigate();
  const { user, isAuthenticated, isLoading: authLoading } = useAuthStore();
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [businesses, setBusinesses] = useState<Business[]>([]);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'overview' | 'users' | 'businesses' | 'reviews'>('overview');
  const [searchQuery, setSearchQuery] = useState('');

  useEffect(() => {
    if (!authLoading) {
      if (!isAuthenticated) {
        navigate({ to: '/login' });
      } else if (user?.role !== 'admin') {
        navigate({ to: '/' });
      }
    }
  }, [authLoading, isAuthenticated, user, navigate]);

  useEffect(() => {
    if (user?.role === 'admin') {
      loadData();
    }
  }, [user, activeTab]);

  const loadData = async () => {
    setIsLoading(true);
    try {
      switch (activeTab) {
        case 'overview':
          const statsResponse = await api.get<AdminStats>('/admin/stats');
          setStats(statsResponse);
          break;
        case 'users':
          const usersResponse = await api.get<{ users: User[] }>('/admin/users');
          setUsers(usersResponse.users);
          break;
        case 'businesses':
          const bizResponse = await api.get<{ businesses: Business[] }>('/admin/businesses');
          setBusinesses(bizResponse.businesses);
          break;
        case 'reviews':
          const reviewsResponse = await api.get<{ reviews: Review[] }>('/admin/reviews');
          setReviews(reviewsResponse.reviews);
          break;
      }
    } catch (error) {
      console.error('Failed to load admin data:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleVerifyBusiness = async (businessId: string, verified: boolean) => {
    try {
      await api.patch(`/admin/businesses/${businessId}/verify`, { verified });
      setBusinesses(
        businesses.map((b) =>
          b.id === businessId ? { ...b, is_verified: verified } : b
        )
      );
    } catch (error) {
      console.error('Failed to verify business:', error);
    }
  };

  const handleDeleteReview = async (reviewId: string) => {
    if (!confirm('Are you sure you want to delete this review?')) return;
    try {
      await api.delete(`/admin/reviews/${reviewId}`);
      setReviews(reviews.filter((r) => r.id !== reviewId));
    } catch (error) {
      console.error('Failed to delete review:', error);
    }
  };

  const handleUpdateUserRole = async (userId: string, role: string) => {
    try {
      await api.patch(`/admin/users/${userId}/role`, { role });
      setUsers(users.map((u) => (u.id === userId ? { ...u, role: role as User['role'] } : u)));
    } catch (error) {
      console.error('Failed to update user role:', error);
    }
  };

  if (authLoading || !isAuthenticated || user?.role !== 'admin') {
    return (
      <div className="max-w-7xl mx-auto px-4 py-8">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-gray-200 rounded w-1/4" />
          <div className="h-64 bg-gray-200 rounded" />
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      <h1 className="text-3xl font-bold text-gray-900 mb-8">Admin Dashboard</h1>

      {/* Tabs */}
      <div className="border-b mb-6">
        <div className="flex gap-4">
          {[
            { key: 'overview', label: 'Overview', icon: TrendingUp },
            { key: 'users', label: 'Users', icon: Users },
            { key: 'businesses', label: 'Businesses', icon: Store },
            { key: 'reviews', label: 'Reviews', icon: MessageSquare },
          ].map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key as typeof activeTab)}
              className={`pb-4 px-2 border-b-2 transition-colors ${
                activeTab === tab.key
                  ? 'border-yelp-red text-yelp-red'
                  : 'border-transparent text-gray-600 hover:text-gray-900'
              }`}
            >
              <span className="flex items-center gap-2">
                <tab.icon className="w-5 h-5" />
                {tab.label}
              </span>
            </button>
          ))}
        </div>
      </div>

      {isLoading ? (
        <div className="animate-pulse space-y-4">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="h-24 bg-gray-200 rounded" />
          ))}
        </div>
      ) : (
        <>
          {/* Overview Tab */}
          {activeTab === 'overview' && stats && (
            <div>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
                <div className="bg-white rounded-lg shadow p-6">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm text-gray-600">Total Users</p>
                      <p className="text-3xl font-bold text-gray-900">{stats.total_users}</p>
                    </div>
                    <Users className="w-10 h-10 text-yelp-blue opacity-50" />
                  </div>
                  <p className="text-sm text-green-600 mt-2">
                    +{stats.new_users_last_7d} this week
                  </p>
                </div>

                <div className="bg-white rounded-lg shadow p-6">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm text-gray-600">Total Businesses</p>
                      <p className="text-3xl font-bold text-gray-900">{stats.total_businesses}</p>
                    </div>
                    <Store className="w-10 h-10 text-yelp-red opacity-50" />
                  </div>
                  <p className="text-sm text-gray-600 mt-2">
                    {stats.claimed_businesses} claimed
                  </p>
                </div>

                <div className="bg-white rounded-lg shadow p-6">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm text-gray-600">Total Reviews</p>
                      <p className="text-3xl font-bold text-gray-900">{stats.total_reviews}</p>
                    </div>
                    <MessageSquare className="w-10 h-10 text-green-500 opacity-50" />
                  </div>
                  <p className="text-sm text-green-600 mt-2">
                    +{stats.reviews_last_24h} today
                  </p>
                </div>

                <div className="bg-white rounded-lg shadow p-6">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm text-gray-600">Average Rating</p>
                      <p className="text-3xl font-bold text-gray-900">{stats.average_rating}</p>
                    </div>
                    <TrendingUp className="w-10 h-10 text-yellow-500 opacity-50" />
                  </div>
                </div>
              </div>

              <div className="bg-white rounded-lg shadow p-6">
                <h3 className="text-lg font-semibold mb-4">Top Cities</h3>
                <div className="space-y-3">
                  {stats.top_cities.map((city, i) => (
                    <div key={i} className="flex items-center justify-between">
                      <span className="text-gray-700">
                        {city.city}, {city.state}
                      </span>
                      <span className="text-gray-600">{city.count} businesses</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Users Tab */}
          {activeTab === 'users' && (
            <div>
              <div className="mb-4">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
                  <input
                    type="text"
                    placeholder="Search users..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="input-field pl-10"
                  />
                </div>
              </div>
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
                    {users
                      .filter(
                        (u) =>
                          !searchQuery ||
                          u.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
                          u.email.toLowerCase().includes(searchQuery.toLowerCase())
                      )
                      .map((u) => (
                        <tr key={u.id}>
                          <td className="px-6 py-4 text-gray-900">{u.name}</td>
                          <td className="px-6 py-4 text-gray-600">{u.email}</td>
                          <td className="px-6 py-4">
                            <select
                              value={u.role}
                              onChange={(e) => handleUpdateUserRole(u.id, e.target.value)}
                              className="input-field py-1 px-2"
                            >
                              <option value="user">User</option>
                              <option value="business_owner">Business Owner</option>
                              <option value="admin">Admin</option>
                            </select>
                          </td>
                          <td className="px-6 py-4 text-gray-600">{u.review_count}</td>
                          <td className="px-6 py-4">
                            <Link
                              to="/users/$id"
                              params={{ id: u.id }}
                              className="text-yelp-blue hover:underline"
                            >
                              View
                            </Link>
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Businesses Tab */}
          {activeTab === 'businesses' && (
            <div>
              <div className="mb-4">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
                  <input
                    type="text"
                    placeholder="Search businesses..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="input-field pl-10"
                  />
                </div>
              </div>
              <div className="bg-white rounded-lg shadow overflow-hidden">
                <table className="w-full">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-6 py-3 text-left text-sm font-medium text-gray-600">Name</th>
                      <th className="px-6 py-3 text-left text-sm font-medium text-gray-600">Location</th>
                      <th className="px-6 py-3 text-left text-sm font-medium text-gray-600">Claimed</th>
                      <th className="px-6 py-3 text-left text-sm font-medium text-gray-600">Verified</th>
                      <th className="px-6 py-3 text-left text-sm font-medium text-gray-600">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {businesses
                      .filter(
                        (b) =>
                          !searchQuery ||
                          b.name.toLowerCase().includes(searchQuery.toLowerCase())
                      )
                      .map((b) => (
                        <tr key={b.id}>
                          <td className="px-6 py-4">
                            <Link
                              to="/business/$slug"
                              params={{ slug: b.slug }}
                              className="text-yelp-blue hover:underline"
                            >
                              {b.name}
                            </Link>
                          </td>
                          <td className="px-6 py-4 text-gray-600">
                            {b.city}, {b.state}
                          </td>
                          <td className="px-6 py-4">
                            {b.is_claimed ? (
                              <CheckCircle className="w-5 h-5 text-green-500" />
                            ) : (
                              <XCircle className="w-5 h-5 text-gray-300" />
                            )}
                          </td>
                          <td className="px-6 py-4">
                            <button
                              onClick={() => handleVerifyBusiness(b.id, !b.is_verified)}
                              className={`flex items-center gap-1 ${
                                b.is_verified ? 'text-green-600' : 'text-gray-400'
                              }`}
                            >
                              {b.is_verified ? (
                                <CheckCircle className="w-5 h-5" />
                              ) : (
                                <XCircle className="w-5 h-5" />
                              )}
                            </button>
                          </td>
                          <td className="px-6 py-4">
                            <Link
                              to="/business/$slug"
                              params={{ slug: b.slug }}
                              className="text-yelp-blue hover:underline"
                            >
                              View
                            </Link>
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Reviews Tab */}
          {activeTab === 'reviews' && (
            <div className="space-y-4">
              {reviews.map((review) => (
                <div key={review.id} className="bg-white rounded-lg shadow p-6">
                  <div className="flex justify-between items-start">
                    <div>
                      <div className="flex items-center gap-2 mb-2">
                        <span className="font-semibold">{review.user_name}</span>
                        <span className="text-gray-400">reviewed</span>
                        <Link
                          to="/business/$slug"
                          params={{ slug: review.business_slug || '' }}
                          className="text-yelp-blue hover:underline"
                        >
                          {review.business_name}
                        </Link>
                      </div>
                      <div className="flex items-center gap-2 mb-2">
                        <span className="text-yellow-500">{'*'.repeat(review.rating)}</span>
                        <span className="text-gray-500 text-sm">
                          {new Date(review.created_at).toLocaleDateString()}
                        </span>
                      </div>
                      <p className="text-gray-700">{review.text}</p>
                    </div>
                    <button
                      onClick={() => handleDeleteReview(review.id)}
                      className="text-red-600 hover:text-red-800"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
