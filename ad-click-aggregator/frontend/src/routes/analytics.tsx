/**
 * @fileoverview Analytics query page route component.
 * Provides an interactive interface for querying aggregated click data.
 * Supports time range selection, grouping options, and result visualization.
 */

import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { getAggregateData } from '../services/api'
import type { AggregateQueryResult } from '../types'
import { ClickChart } from '../components/ClickChart'
import { StatCard } from '../components/StatCard'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'

/**
 * Route definition for the analytics page.
 */
export const Route = createFileRoute('/analytics')({
  component: Analytics,
})

/**
 * Analytics query builder and results viewer.
 * Allows configuring time range, granularity, and grouping dimensions.
 *
 * @returns Query form and results visualization
 */
function Analytics() {
  const [startTime, setStartTime] = useState(() => {
    const date = new Date()
    date.setHours(date.getHours() - 24)
    return date.toISOString().slice(0, 16)
  })
  const [endTime, setEndTime] = useState(() => {
    return new Date().toISOString().slice(0, 16)
  })
  const [granularity, setGranularity] = useState<'minute' | 'hour' | 'day'>('hour')
  const [groupBy, setGroupBy] = useState<string[]>([])
  const [result, setResult] = useState<AggregateQueryResult | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleQuery = async () => {
    setIsLoading(true)
    setError(null)

    try {
      const data = await getAggregateData({
        startTime: new Date(startTime).toISOString(),
        endTime: new Date(endTime).toISOString(),
        granularity,
        groupBy: groupBy.join(',') || undefined,
      })
      setResult(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Query failed')
    } finally {
      setIsLoading(false)
    }
  }

  const toggleGroupBy = (field: string) => {
    setGroupBy((prev) =>
      prev.includes(field) ? prev.filter((f) => f !== field) : [...prev, field]
    )
  }

  const chartData = result?.data.map((d) => ({
    timestamp: d.time_bucket,
    clicks: d.clicks,
  })) ?? []

  const countryData = result?.data
    .filter((d) => d.country)
    .reduce((acc, d) => {
      const existing = acc.find((a) => a.country === d.country)
      if (existing) {
        existing.clicks += d.clicks
      } else {
        acc.push({ country: d.country!, clicks: d.clicks })
      }
      return acc
    }, [] as { country: string; clicks: number }[])
    .sort((a, b) => b.clicks - a.clicks)
    .slice(0, 10) ?? []

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-gray-900">Analytics</h1>

      {/* Query Form */}
      <div className="rounded-lg border border-gray-200 bg-white p-6">
        <h2 className="mb-4 font-semibold text-gray-900">Query Parameters</h2>

        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          <div>
            <label className="block text-sm font-medium text-gray-700">Start Time</label>
            <input
              type="datetime-local"
              value={startTime}
              onChange={(e) => setStartTime(e.target.value)}
              className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700">End Time</label>
            <input
              type="datetime-local"
              value={endTime}
              onChange={(e) => setEndTime(e.target.value)}
              className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700">Granularity</label>
            <select
              value={granularity}
              onChange={(e) => setGranularity(e.target.value as 'minute' | 'hour' | 'day')}
              className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            >
              <option value="minute">Minute</option>
              <option value="hour">Hour</option>
              <option value="day">Day</option>
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700">Group By</label>
            <div className="mt-2 flex flex-wrap gap-2">
              {['country', 'device_type'].map((field) => (
                <button
                  key={field}
                  onClick={() => toggleGroupBy(field)}
                  className={`rounded-md px-3 py-1 text-sm font-medium transition ${
                    groupBy.includes(field)
                      ? 'bg-blue-600 text-white'
                      : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                  }`}
                >
                  {field}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="mt-4">
          <button
            onClick={handleQuery}
            disabled={isLoading}
            className="rounded-md bg-blue-600 px-6 py-2 font-medium text-white transition hover:bg-blue-700 disabled:opacity-50"
          >
            {isLoading ? 'Querying...' : 'Run Query'}
          </button>
        </div>

        {error && (
          <div className="mt-4 rounded-md bg-red-50 p-4 text-red-700">
            Error: {error}
          </div>
        )}
      </div>

      {/* Results */}
      {result && (
        <>
          {/* Summary Stats */}
          <div className="grid gap-4 md:grid-cols-3">
            <StatCard
              title="Total Clicks"
              value={result.total_clicks}
              color="blue"
            />
            <StatCard
              title="Unique Users"
              value={result.total_unique_users}
              color="green"
            />
            <StatCard
              title="Query Time"
              value={`${result.query_time_ms}ms`}
              color="purple"
            />
          </div>

          {/* Time Series Chart */}
          <ClickChart
            data={chartData}
            title={`Clicks Over Time (${granularity}ly)`}
          />

          {/* Country Breakdown (if grouped by country) */}
          {groupBy.includes('country') && countryData.length > 0 && (
            <div className="rounded-lg border border-gray-200 bg-white p-6">
              <h3 className="mb-4 font-semibold text-gray-900">Top Countries</h3>
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={countryData}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="country" />
                  <YAxis />
                  <Tooltip />
                  <Bar dataKey="clicks" fill="#3b82f6" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* Data Table */}
          <div className="rounded-lg border border-gray-200 bg-white">
            <div className="border-b border-gray-200 px-6 py-4">
              <h3 className="font-semibold text-gray-900">
                Query Results ({result.data.length} rows)
              </h3>
            </div>
            <div className="max-h-96 overflow-auto">
              <table className="w-full">
                <thead className="sticky top-0 bg-gray-50">
                  <tr>
                    <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                      Time
                    </th>
                    {groupBy.includes('country') && (
                      <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                        Country
                      </th>
                    )}
                    {groupBy.includes('device_type') && (
                      <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                        Device
                      </th>
                    )}
                    <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                      Clicks
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                      Users
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                      Fraud Rate
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200">
                  {result.data.map((row, i) => (
                    <tr key={i} className="hover:bg-gray-50">
                      <td className="whitespace-nowrap px-6 py-4 text-sm text-gray-900">
                        {new Date(row.time_bucket).toLocaleString()}
                      </td>
                      {groupBy.includes('country') && (
                        <td className="whitespace-nowrap px-6 py-4 text-sm text-gray-600">
                          {row.country || '-'}
                        </td>
                      )}
                      {groupBy.includes('device_type') && (
                        <td className="whitespace-nowrap px-6 py-4 text-sm text-gray-600">
                          {row.device_type || '-'}
                        </td>
                      )}
                      <td className="whitespace-nowrap px-6 py-4 text-sm font-medium text-gray-900">
                        {row.clicks.toLocaleString()}
                      </td>
                      <td className="whitespace-nowrap px-6 py-4 text-sm text-gray-600">
                        {row.unique_users.toLocaleString()}
                      </td>
                      <td className="whitespace-nowrap px-6 py-4 text-sm">
                        <span
                          className={
                            row.fraud_rate > 0.05 ? 'text-red-600' : 'text-green-600'
                          }
                        >
                          {(row.fraud_rate * 100).toFixed(2)}%
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
