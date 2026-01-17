/**
 * @fileoverview Recent clicks page route component.
 * Displays a paginated table of recent click events.
 * Supports filtering by fraud status and configurable result limits.
 */

import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { useDashboardStore } from '../stores/dashboardStore'
import { ClickTable } from '../components/ClickTable'

/**
 * Route definition for the recent clicks page.
 */
export const Route = createFileRoute('/clicks')({
  component: Clicks,
})

/**
 * Recent clicks viewer with filtering options.
 * Shows individual click events for monitoring and debugging.
 *
 * @returns Click table with filter controls
 */
function Clicks() {
  const { recentClicks, fetchRecentClicks, isLoading } = useDashboardStore()
  const [limit, setLimit] = useState(100)
  const [fraudOnly, setFraudOnly] = useState(false)

  useEffect(() => {
    fetchRecentClicks(limit, fraudOnly)
  }, [fetchRecentClicks, limit, fraudOnly])

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">Recent Clicks</h1>

        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <label htmlFor="limit" className="text-sm font-medium text-gray-700">
              Show:
            </label>
            <select
              id="limit"
              value={limit}
              onChange={(e) => setLimit(parseInt(e.target.value))}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            >
              <option value={25}>25</option>
              <option value={50}>50</option>
              <option value={100}>100</option>
              <option value={250}>250</option>
              <option value={500}>500</option>
            </select>
          </div>

          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={fraudOnly}
              onChange={(e) => setFraudOnly(e.target.checked)}
              className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
            />
            <span className="text-sm font-medium text-gray-700">Fraud only</span>
          </label>

          <button
            onClick={() => fetchRecentClicks(limit, fraudOnly)}
            disabled={isLoading}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-700 disabled:opacity-50"
          >
            {isLoading ? 'Loading...' : 'Refresh'}
          </button>
        </div>
      </div>

      <ClickTable
        clicks={recentClicks}
        title={fraudOnly ? 'Fraudulent Clicks' : 'All Recent Clicks'}
      />

      <div className="text-sm text-gray-500">
        Showing {recentClicks.length} click{recentClicks.length !== 1 ? 's' : ''}
        {fraudOnly && ' (fraud only)'}
      </div>
    </div>
  )
}
