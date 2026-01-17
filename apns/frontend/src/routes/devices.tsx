import { createFileRoute, Navigate } from '@tanstack/react-router'
import { useAuthStore } from '../stores/authStore'
import { adminApi } from '../services/api'
import { useState, useEffect } from 'react'

interface Device {
  device_id: string
  token_hash: string
  app_bundle_id: string
  device_info: unknown
  is_valid: boolean
  created_at: string
  last_seen: string
}

export const Route = createFileRoute('/devices')({
  component: Devices,
})

function Devices() {
  const { isAuthenticated } = useAuthStore()
  const [devices, setDevices] = useState<Device[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(0)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const limit = 20

  useEffect(() => {
    if (isAuthenticated) {
      fetchDevices()
    }
  }, [isAuthenticated, page])

  const fetchDevices = async () => {
    setIsLoading(true)
    setError(null)
    try {
      const response = await adminApi.getDevices(limit, page * limit)
      setDevices(response.devices)
      setTotal(response.total)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch devices')
    } finally {
      setIsLoading(false)
    }
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" />
  }

  const totalPages = Math.ceil(total / limit)

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h1 className="text-2xl font-bold text-gray-900">Devices</h1>
        <div className="text-sm text-gray-500">
          {total} total devices
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
              <th>Device ID</th>
              <th>Token Hash</th>
              <th>App Bundle ID</th>
              <th>Status</th>
              <th>Last Seen</th>
              <th>Created At</th>
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-200">
            {isLoading ? (
              <tr>
                <td colSpan={6} className="text-center py-8 text-gray-500">
                  Loading...
                </td>
              </tr>
            ) : devices.length === 0 ? (
              <tr>
                <td colSpan={6} className="text-center py-8 text-gray-500">
                  No devices registered
                </td>
              </tr>
            ) : (
              devices.map((device) => (
                <tr key={device.device_id}>
                  <td className="font-mono text-xs">{device.device_id.slice(0, 8)}...</td>
                  <td className="font-mono text-xs">{device.token_hash.slice(0, 16)}...</td>
                  <td>{device.app_bundle_id}</td>
                  <td>
                    <span className={`badge ${device.is_valid ? 'badge-success' : 'badge-error'}`}>
                      {device.is_valid ? 'Valid' : 'Invalid'}
                    </span>
                  </td>
                  <td>{new Date(device.last_seen).toLocaleString()}</td>
                  <td>{new Date(device.created_at).toLocaleString()}</td>
                </tr>
              ))
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
