import { createFileRoute } from '@tanstack/react-router'
import { useEffect } from 'react'
import { useDashboardStore } from '../stores/dashboardStore'
import { StatCard } from '../components/StatCard'
import { ClickChart } from '../components/ClickChart'
import { ClickTable } from '../components/ClickTable'

export const Route = createFileRoute('/')({
  component: Dashboard,
})

function Dashboard() {
  const { stats, realTimeStats, recentClicks, isLoading, error, lastUpdated, refreshAll } =
    useDashboardStore()

  useEffect(() => {
    refreshAll()
    // Refresh every 30 seconds
    const interval = setInterval(refreshAll, 30000)
    return () => clearInterval(interval)
  }, [refreshAll])

  if (isLoading && !stats) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <div className="text-gray-500">Loading dashboard...</div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">Dashboard</h1>
        <div className="flex items-center gap-4">
          {lastUpdated && (
            <span className="text-sm text-gray-500">
              Last updated: {lastUpdated.toLocaleTimeString()}
            </span>
          )}
          <button
            onClick={refreshAll}
            disabled={isLoading}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-700 disabled:opacity-50"
          >
            {isLoading ? 'Refreshing...' : 'Refresh'}
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-md bg-red-50 p-4 text-red-700">
          Error: {error}
        </div>
      )}

      {/* Stats Grid */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <StatCard
          title="Total Clicks"
          value={stats?.total_clicks ?? 0}
          subtitle="All time"
          color="blue"
        />
        <StatCard
          title="Clicks (24h)"
          value={stats?.clicks_last_24h ?? 0}
          subtitle="Last 24 hours"
          color="green"
        />
        <StatCard
          title="Clicks (1h)"
          value={stats?.clicks_last_hour ?? 0}
          subtitle="Last hour"
          color="purple"
        />
        <StatCard
          title="Fraud Rate"
          value={`${((stats?.fraud_rate ?? 0) * 100).toFixed(2)}%`}
          subtitle={`${stats?.total_fraud_clicks ?? 0} fraudulent clicks`}
          color={stats?.fraud_rate && stats.fraud_rate > 0.05 ? 'red' : 'green'}
        />
      </div>

      {/* Secondary Stats */}
      <div className="grid gap-4 md:grid-cols-3">
        <StatCard
          title="Active Campaigns"
          value={stats?.total_campaigns ?? 0}
          color="blue"
        />
        <StatCard
          title="Active Ads"
          value={stats?.total_ads ?? 0}
          color="blue"
        />
        <StatCard
          title="Advertisers"
          value={stats?.total_advertisers ?? 0}
          color="blue"
        />
      </div>

      {/* Real-time Chart */}
      <ClickChart
        data={realTimeStats?.time_series ?? []}
        title="Clicks Over Time (Last 60 Minutes)"
      />

      {/* Real-time Stats */}
      {realTimeStats && (
        <div className="grid gap-4 md:grid-cols-2">
          <StatCard
            title="Clicks Per Minute (Avg)"
            value={realTimeStats.clicks_per_minute.toFixed(2)}
            subtitle="Last 60 minutes average"
            color="purple"
          />
          <StatCard
            title="Total (Last 60 min)"
            value={realTimeStats.total_clicks}
            subtitle="Sum of last 60 minutes"
            color="green"
          />
        </div>
      )}

      {/* Recent Clicks */}
      <ClickTable
        clicks={recentClicks.slice(0, 10)}
        title="Recent Clicks (Last 10)"
      />
    </div>
  )
}
