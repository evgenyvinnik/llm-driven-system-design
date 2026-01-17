import { createFileRoute, Outlet, Link, useNavigate } from '@tanstack/react-router';
import { useEffect } from 'react';
import { useAuthStore } from '../stores/authStore';

function AdminLayout() {
  const { isAuthenticated, user } = useAuthStore();
  const navigate = useNavigate();

  useEffect(() => {
    if (!isAuthenticated) {
      navigate({ to: '/login' });
    } else if (user?.role !== 'admin') {
      navigate({ to: '/' });
    }
  }, [isAuthenticated, user, navigate]);

  if (!isAuthenticated || user?.role !== 'admin') {
    return null;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">Admin Dashboard</h1>
      </div>

      <div className="flex space-x-4 border-b border-gray-200">
        <Link
          to="/admin"
          activeOptions={{ exact: true }}
          className="px-4 py-2 text-sm font-medium border-b-2 -mb-px"
          activeProps={{ className: 'border-indigo-600 text-indigo-600' }}
          inactiveProps={{ className: 'border-transparent text-gray-500 hover:text-gray-700' }}
        >
          Overview
        </Link>
        <Link
          to="/admin/campaigns"
          className="px-4 py-2 text-sm font-medium border-b-2 -mb-px"
          activeProps={{ className: 'border-indigo-600 text-indigo-600' }}
          inactiveProps={{ className: 'border-transparent text-gray-500 hover:text-gray-700' }}
        >
          Campaigns
        </Link>
        <Link
          to="/admin/templates"
          className="px-4 py-2 text-sm font-medium border-b-2 -mb-px"
          activeProps={{ className: 'border-indigo-600 text-indigo-600' }}
          inactiveProps={{ className: 'border-transparent text-gray-500 hover:text-gray-700' }}
        >
          Templates
        </Link>
        <Link
          to="/admin/users"
          className="px-4 py-2 text-sm font-medium border-b-2 -mb-px"
          activeProps={{ className: 'border-indigo-600 text-indigo-600' }}
          inactiveProps={{ className: 'border-transparent text-gray-500 hover:text-gray-700' }}
        >
          Users
        </Link>
      </div>

      <Outlet />
    </div>
  );
}

export const Route = createFileRoute('/admin')({
  component: AdminLayout,
});
