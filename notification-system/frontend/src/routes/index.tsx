import { createFileRoute, Link } from '@tanstack/react-router';
import { useEffect } from 'react';
import { useAuthStore } from '../stores/authStore';
import { useNotificationStore } from '../stores/notificationStore';

function IndexPage() {
  const { isAuthenticated, user } = useAuthStore();
  const { notifications, rateLimitUsage, fetchNotifications, fetchRateLimitUsage } = useNotificationStore();

  useEffect(() => {
    if (isAuthenticated) {
      fetchNotifications({ limit: 5 });
      fetchRateLimitUsage();
    }
  }, [isAuthenticated, fetchNotifications, fetchRateLimitUsage]);

  if (!isAuthenticated) {
    return (
      <div className="text-center py-12">
        <h1 className="text-4xl font-bold text-gray-900 mb-4">
          Welcome to NotifyHub
        </h1>
        <p className="text-lg text-gray-600 mb-8">
          A high-throughput notification system for delivering messages across multiple channels.
        </p>
        <div className="space-x-4">
          <Link
            to="/login"
            className="inline-block px-6 py-3 bg-indigo-600 text-white font-medium rounded-lg hover:bg-indigo-700"
          >
            Login
          </Link>
          <Link
            to="/register"
            className="inline-block px-6 py-3 bg-white text-indigo-600 font-medium rounded-lg border border-indigo-600 hover:bg-indigo-50"
          >
            Register
          </Link>
        </div>
      </div>
    );
  }

  const recentNotifications = notifications.slice(0, 5);
  const stats = {
    delivered: notifications.filter((n) => n.status === 'delivered').length,
    pending: notifications.filter((n) => n.status === 'pending').length,
    failed: notifications.filter((n) => n.status === 'failed').length,
  };

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h1 className="text-2xl font-bold text-gray-900">Dashboard</h1>
        <span className="text-sm text-gray-500">Welcome, {user?.name}</span>
      </div>

      {/* Rate Limit Usage */}
      {rateLimitUsage && (
        <div className="bg-white rounded-lg shadow p-6">
          <h2 className="text-lg font-semibold mb-4">Rate Limit Usage</h2>
          <div className="grid grid-cols-3 gap-4">
            {Object.entries(rateLimitUsage).map(([channel, usage]) => (
              <div key={channel} className="text-center">
                <div className="text-sm font-medium text-gray-500 capitalize">{channel}</div>
                <div className="mt-1">
                  <span className="text-2xl font-bold text-gray-900">{usage.used}</span>
                  <span className="text-gray-500">/{usage.limit}</span>
                </div>
                <div className="mt-1 h-2 bg-gray-200 rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full ${
                      usage.used / usage.limit > 0.8
                        ? 'bg-red-500'
                        : usage.used / usage.limit > 0.5
                          ? 'bg-yellow-500'
                          : 'bg-green-500'
                    }`}
                    style={{ width: `${Math.min(100, (usage.used / usage.limit) * 100)}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Quick Stats */}
      <div className="grid grid-cols-3 gap-4">
        <div className="bg-white rounded-lg shadow p-6 text-center">
          <div className="text-3xl font-bold text-green-600">{stats.delivered}</div>
          <div className="text-sm text-gray-500">Delivered</div>
        </div>
        <div className="bg-white rounded-lg shadow p-6 text-center">
          <div className="text-3xl font-bold text-yellow-600">{stats.pending}</div>
          <div className="text-sm text-gray-500">Pending</div>
        </div>
        <div className="bg-white rounded-lg shadow p-6 text-center">
          <div className="text-3xl font-bold text-red-600">{stats.failed}</div>
          <div className="text-sm text-gray-500">Failed</div>
        </div>
      </div>

      {/* Recent Notifications */}
      <div className="bg-white rounded-lg shadow">
        <div className="px-6 py-4 border-b border-gray-200 flex justify-between items-center">
          <h2 className="text-lg font-semibold">Recent Notifications</h2>
          <Link to="/notifications" className="text-sm text-indigo-600 hover:text-indigo-800">
            View all
          </Link>
        </div>
        <div className="divide-y divide-gray-200">
          {recentNotifications.length === 0 ? (
            <div className="px-6 py-8 text-center text-gray-500">
              No notifications yet
            </div>
          ) : (
            recentNotifications.map((notification) => (
              <div key={notification.id} className="px-6 py-4 flex items-center justify-between">
                <div>
                  <div className="text-sm font-medium text-gray-900">
                    {notification.template_id || 'Direct notification'}
                  </div>
                  <div className="text-sm text-gray-500">
                    {notification.channels.join(', ')} - {new Date(notification.created_at).toLocaleString()}
                  </div>
                </div>
                <span
                  className={`px-2 py-1 text-xs font-medium rounded-full ${
                    notification.status === 'delivered'
                      ? 'bg-green-100 text-green-800'
                      : notification.status === 'pending'
                        ? 'bg-yellow-100 text-yellow-800'
                        : notification.status === 'failed'
                          ? 'bg-red-100 text-red-800'
                          : 'bg-gray-100 text-gray-800'
                  }`}
                >
                  {notification.status}
                </span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

export const Route = createFileRoute('/')({
  component: IndexPage,
});
