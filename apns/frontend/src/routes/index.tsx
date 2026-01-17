import { createFileRoute, Navigate } from '@tanstack/react-router'
import { useAuthStore } from '../stores/authStore'
import { useDashboardStore } from '../stores/dashboardStore'
import { useEffect } from 'react'

export const Route = createFileRoute('/')({
  component: Dashboard,
})

function Dashboard() {
  const { isAuthenticated } = useAuthStore()
  const { notifications, devices, topics, recentNotifications, isLoading, error, fetchStats } = useDashboardStore()

  useEffect(() => {
    if (isAuthenticated) {
      fetchStats()
      const interval = setInterval(fetchStats, 30000) // Refresh every 30 seconds
      return () => clearInterval(interval)
    }
  }, [isAuthenticated, fetchStats])

  if (!isAuthenticated) {
    return <Navigate to="/login" />
  }

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'delivered':
        return 'badge-success'
      case 'pending':
      case 'queued':
        return 'badge-warning'
      case 'failed':
      case 'expired':
        return 'badge-error'
      default:
        return 'badge-gray'
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h1 className="text-2xl font-bold text-gray-900">Dashboard</h1>
        <button
          onClick={() => fetchStats()}
          className="btn btn-secondary"
          disabled={isLoading}
        >
          {isLoading ? 'Refreshing...' : 'Refresh'}
        </button>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700">
          {error}
        </div>
      )}

      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="stat-card">
          <h3 className="text-sm font-medium text-gray-500">Total Devices</h3>
          <p className="text-3xl font-bold text-gray-900">{devices.total}</p>
          <p className="text-sm text-gray-500">
            {devices.valid} valid / {devices.invalid} invalid
          </p>
        </div>

        <div className="stat-card">
          <h3 className="text-sm font-medium text-gray-500">Total Notifications</h3>
          <p className="text-3xl font-bold text-gray-900">{notifications.total}</p>
          <p className="text-sm text-green-600">{notifications.delivered} delivered</p>
        </div>

        <div className="stat-card">
          <h3 className="text-sm font-medium text-gray-500">Pending</h3>
          <p className="text-3xl font-bold text-yellow-600">
            {notifications.pending + notifications.queued}
          </p>
          <p className="text-sm text-gray-500">
            {notifications.pending} pending / {notifications.queued} queued
          </p>
        </div>

        <div className="stat-card">
          <h3 className="text-sm font-medium text-gray-500">Failed/Expired</h3>
          <p className="text-3xl font-bold text-red-600">
            {notifications.failed + notifications.expired}
          </p>
          <p className="text-sm text-gray-500">
            {notifications.failed} failed / {notifications.expired} expired
          </p>
        </div>
      </div>

      {/* Topics */}
      {topics.length > 0 && (
        <div className="card">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">Popular Topics</h2>
          <div className="flex flex-wrap gap-2">
            {topics.map((topic) => (
              <span key={topic.topic} className="badge badge-info">
                {topic.topic} ({topic.subscriber_count})
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Recent Notifications */}
      <div className="card">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Recent Notifications</h2>
        {recentNotifications.length === 0 ? (
          <p className="text-gray-500">No notifications yet</p>
        ) : (
          <div className="table-container">
            <table className="table">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Device ID</th>
                  <th>Status</th>
                  <th>Created At</th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {recentNotifications.map((notification) => (
                  <tr key={notification.id}>
                    <td className="font-mono text-xs">{notification.id.slice(0, 8)}...</td>
                    <td className="font-mono text-xs">{notification.device_id.slice(0, 8)}...</td>
                    <td>
                      <span className={`badge ${getStatusBadge(notification.status)}`}>
                        {notification.status}
                      </span>
                    </td>
                    <td>{new Date(notification.created_at).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
