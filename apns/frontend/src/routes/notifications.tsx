import { createFileRoute, Navigate } from '@tanstack/react-router'
import { useAuthStore } from '../stores/authStore'
import { adminApi } from '../services/api'
import { useState, useEffect } from 'react'

interface Notification {
  id: string
  device_id: string
  status: string
  priority: number
  created_at: string
  updated_at: string
  payload: unknown
}

export const Route = createFileRoute('/notifications')({
  component: Notifications,
})

function Notifications() {
  const { isAuthenticated } = useAuthStore()
  const [notifications, setNotifications] = useState<Notification[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(0)
  const [statusFilter, setStatusFilter] = useState<string>('')
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const limit = 20

  useEffect(() => {
    if (isAuthenticated) {
      fetchNotifications()
    }
  }, [isAuthenticated, page, statusFilter])

  const fetchNotifications = async () => {
    setIsLoading(true)
    setError(null)
    try {
      const response = await adminApi.getNotifications(
        limit,
        page * limit,
        statusFilter || undefined
      )
      setNotifications(response.notifications)
      setTotal(response.total)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch notifications')
    } finally {
      setIsLoading(false)
    }
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" />
  }

  const totalPages = Math.ceil(total / limit)

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

  const getPriorityLabel = (priority: number) => {
    switch (priority) {
      case 10:
        return { label: 'High', class: 'badge-error' }
      case 5:
        return { label: 'Medium', class: 'badge-warning' }
      case 1:
        return { label: 'Low', class: 'badge-gray' }
      default:
        return { label: String(priority), class: 'badge-gray' }
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h1 className="text-2xl font-bold text-gray-900">Notifications</h1>
        <div className="flex items-center space-x-4">
          <select
            value={statusFilter}
            onChange={(e) => {
              setStatusFilter(e.target.value)
              setPage(0)
            }}
            className="input w-auto"
          >
            <option value="">All Statuses</option>
            <option value="pending">Pending</option>
            <option value="queued">Queued</option>
            <option value="delivered">Delivered</option>
            <option value="failed">Failed</option>
            <option value="expired">Expired</option>
          </select>
          <span className="text-sm text-gray-500">{total} total</span>
        </div>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700">
          {error}
        </div>
      )}

      <div className="table-container">
        <table className="table">
          <thead>
            <tr>
              <th>ID</th>
              <th>Device ID</th>
              <th>Priority</th>
              <th>Status</th>
              <th>Created At</th>
              <th>Updated At</th>
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-200">
            {isLoading ? (
              <tr>
                <td colSpan={6} className="text-center py-8 text-gray-500">
                  Loading...
                </td>
              </tr>
            ) : notifications.length === 0 ? (
              <tr>
                <td colSpan={6} className="text-center py-8 text-gray-500">
                  No notifications found
                </td>
              </tr>
            ) : (
              notifications.map((notification) => {
                const priorityInfo = getPriorityLabel(notification.priority)
                return (
                  <tr key={notification.id}>
                    <td className="font-mono text-xs">{notification.id.slice(0, 8)}...</td>
                    <td className="font-mono text-xs">{notification.device_id.slice(0, 8)}...</td>
                    <td>
                      <span className={`badge ${priorityInfo.class}`}>
                        {priorityInfo.label}
                      </span>
                    </td>
                    <td>
                      <span className={`badge ${getStatusBadge(notification.status)}`}>
                        {notification.status}
                      </span>
                    </td>
                    <td>{new Date(notification.created_at).toLocaleString()}</td>
                    <td>{new Date(notification.updated_at).toLocaleString()}</td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex justify-center space-x-2">
          <button
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            disabled={page === 0 || isLoading}
            className="btn btn-secondary"
          >
            Previous
          </button>
          <span className="flex items-center px-4 text-sm text-gray-700">
            Page {page + 1} of {totalPages}
          </span>
          <button
            onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
            disabled={page >= totalPages - 1 || isLoading}
            className="btn btn-secondary"
          >
            Next
          </button>
        </div>
      )}
    </div>
  )
}
