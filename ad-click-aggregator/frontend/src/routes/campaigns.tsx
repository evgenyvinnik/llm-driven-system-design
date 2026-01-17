/**
 * @fileoverview Campaigns page route component.
 * Displays campaign list with detailed performance summaries.
 * Shows country and device breakdowns with interactive charts.
 */

import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { useDashboardStore } from '../stores/dashboardStore'
import { getCampaignSummary } from '../services/api'
import type { CampaignSummary } from '../types'
import { StatCard } from '../components/StatCard'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, PieChart, Pie, Cell } from 'recharts'

/**
 * Route definition for the campaigns page.
 */
export const Route = createFileRoute('/campaigns')({
  component: Campaigns,
})

/** Color palette for pie chart segments */
const COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#06b6d4', '#84cc16']

/**
 * Campaign management and analytics view.
 * Allows selecting campaigns and viewing detailed performance metrics.
 *
 * @returns Campaign list and detail panels
 */
function Campaigns() {
  const { campaigns, fetchCampaigns, isLoading } = useDashboardStore()
  const [selectedCampaign, setSelectedCampaign] = useState<string | null>(null)
  const [summary, setSummary] = useState<CampaignSummary | null>(null)
  const [loadingSummary, setLoadingSummary] = useState(false)

  useEffect(() => {
    fetchCampaigns()
  }, [fetchCampaigns])

  useEffect(() => {
    if (selectedCampaign) {
      setLoadingSummary(true)
      const endTime = new Date().toISOString()
      const startTime = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()

      getCampaignSummary(selectedCampaign, startTime, endTime)
        .then(setSummary)
        .catch(console.error)
        .finally(() => setLoadingSummary(false))
    }
  }, [selectedCampaign])

  if (isLoading && campaigns.length === 0) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <div className="text-gray-500">Loading campaigns...</div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-gray-900">Campaigns</h1>

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Campaign List */}
        <div className="rounded-lg border border-gray-200 bg-white">
          <div className="border-b border-gray-200 px-4 py-3">
            <h2 className="font-semibold text-gray-900">Select Campaign</h2>
          </div>
          <div className="divide-y divide-gray-100">
            {campaigns.map((campaign) => (
              <button
                key={campaign.id}
                onClick={() => setSelectedCampaign(campaign.id)}
                className={`w-full px-4 py-3 text-left transition hover:bg-gray-50 ${
                  selectedCampaign === campaign.id ? 'bg-blue-50' : ''
                }`}
              >
                <div className="font-medium text-gray-900">{campaign.name}</div>
                <div className="text-sm text-gray-500">{campaign.advertiser_name}</div>
                <div className="mt-1">
                  <span
                    className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                      campaign.status === 'active'
                        ? 'bg-green-100 text-green-800'
                        : 'bg-gray-100 text-gray-800'
                    }`}
                  >
                    {campaign.status}
                  </span>
                </div>
              </button>
            ))}
            {campaigns.length === 0 && (
              <div className="px-4 py-8 text-center text-gray-500">
                No campaigns found
              </div>
            )}
          </div>
        </div>

        {/* Campaign Details */}
        <div className="lg:col-span-2 space-y-6">
          {!selectedCampaign ? (
            <div className="flex h-64 items-center justify-center rounded-lg border border-gray-200 bg-white text-gray-500">
              Select a campaign to view details
            </div>
          ) : loadingSummary ? (
            <div className="flex h-64 items-center justify-center rounded-lg border border-gray-200 bg-white text-gray-500">
              Loading campaign data...
            </div>
          ) : summary ? (
            <>
              {/* Stats */}
              <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
                <StatCard
                  title="Total Clicks"
                  value={summary.total_clicks}
                  color="blue"
                />
                <StatCard
                  title="Unique Users"
                  value={summary.unique_users}
                  color="green"
                />
                <StatCard
                  title="Fraud Clicks"
                  value={summary.fraud_count}
                  color="red"
                />
                <StatCard
                  title="Fraud Rate"
                  value={`${(summary.fraud_rate * 100).toFixed(2)}%`}
                  color={summary.fraud_rate > 0.05 ? 'red' : 'green'}
                />
              </div>

              {/* Charts */}
              <div className="grid gap-6 lg:grid-cols-2">
                {/* Top Countries */}
                <div className="rounded-lg border border-gray-200 bg-white p-6">
                  <h3 className="mb-4 font-semibold text-gray-900">Clicks by Country</h3>
                  {summary.top_countries.length === 0 ? (
                    <div className="flex h-48 items-center justify-center text-gray-500">
                      No data available
                    </div>
                  ) : (
                    <ResponsiveContainer width="100%" height={200}>
                      <BarChart data={summary.top_countries}>
                        <CartesianGrid strokeDasharray="3 3" />
                        <XAxis dataKey="country" />
                        <YAxis />
                        <Tooltip />
                        <Bar dataKey="clicks" fill="#3b82f6" />
                      </BarChart>
                    </ResponsiveContainer>
                  )}
                </div>

                {/* Device Types */}
                <div className="rounded-lg border border-gray-200 bg-white p-6">
                  <h3 className="mb-4 font-semibold text-gray-900">Clicks by Device</h3>
                  {summary.top_devices.length === 0 ? (
                    <div className="flex h-48 items-center justify-center text-gray-500">
                      No data available
                    </div>
                  ) : (
                    <ResponsiveContainer width="100%" height={200}>
                      <PieChart>
                        <Pie
                          data={summary.top_devices}
                          dataKey="clicks"
                          nameKey="device_type"
                          cx="50%"
                          cy="50%"
                          outerRadius={80}
                          label={({ device_type, percent }) =>
                            `${device_type} (${(percent * 100).toFixed(0)}%)`
                          }
                        >
                          {summary.top_devices.map((_, index) => (
                            <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                          ))}
                        </Pie>
                        <Tooltip />
                      </PieChart>
                    </ResponsiveContainer>
                  )}
                </div>
              </div>
            </>
          ) : null}
        </div>
      </div>
    </div>
  )
}
