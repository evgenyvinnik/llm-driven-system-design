import { createFileRoute, Navigate } from '@tanstack/react-router';
import { useAuthStore } from '../stores/authStore';
import { useEffect, useState } from 'react';
import api from '../services/api';
import { AdminStats } from '../types';

function AdminPage() {
  const { isAuthenticated, user } = useAuthStore();
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (isAuthenticated && user?.role === 'admin') {
      api.get<AdminStats>('/admin/stats')
        .then((res) => setStats(res.data))
        .catch(console.error)
        .finally(() => setIsLoading(false));
    }
  }, [isAuthenticated, user]);

  if (!isAuthenticated) {
    return <Navigate to="/login" />;
  }

  if (user?.role !== 'admin') {
    return <Navigate to="/" />;
  }

  if (isLoading) {
    return (
      <div className="flex justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600"></div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Admin Dashboard</h1>
        <p className="text-gray-600 mt-1">System overview and management</p>
      </div>

      <div className="grid md:grid-cols-4 gap-4">
        <div className="card">
          <p className="text-sm text-gray-500">Total Users</p>
          <p className="text-3xl font-bold text-gray-900">{stats?.users || 0}</p>
        </div>
        <div className="card">
          <p className="text-sm text-gray-500">Total Products</p>
          <p className="text-3xl font-bold text-gray-900">{stats?.products || 0}</p>
        </div>
        <div className="card">
          <p className="text-sm text-gray-500">Alerts Today</p>
          <p className="text-3xl font-bold text-gray-900">{stats?.alertsToday || 0}</p>
        </div>
        <div className="card">
          <p className="text-sm text-gray-500">Price Points Today</p>
          <p className="text-3xl font-bold text-gray-900">{stats?.pricePointsToday || 0}</p>
        </div>
      </div>

      <div className="grid md:grid-cols-2 gap-6">
        <div className="card">
          <h2 className="text-lg font-semibold mb-4">Products by Status</h2>
          <div className="space-y-2">
            {stats?.productsByStatus.map((item) => (
              <div key={item.status} className="flex justify-between items-center">
                <span className="capitalize">{item.status}</span>
                <span className="font-medium">{item.count}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="card">
          <h2 className="text-lg font-semibold mb-4">Recent Scrapes by Domain</h2>
          <div className="space-y-2">
            {stats?.recentScrapesByDomain.map((item) => (
              <div key={item.domain} className="flex justify-between items-center">
                <span>{item.domain}</span>
                <span className="font-medium">{item.count}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export const Route = createFileRoute('/admin')({
  component: AdminPage,
});
