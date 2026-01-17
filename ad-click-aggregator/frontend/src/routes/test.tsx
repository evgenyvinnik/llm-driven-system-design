/**
 * @fileoverview Test click generation page route component.
 * Provides tools for sending test click events to validate the system.
 * Includes single click and batch generation capabilities.
 */

import { createFileRoute } from '@tanstack/react-router'
import { useEffect } from 'react'
import { useDashboardStore } from '../stores/dashboardStore'
import { TestClickForm } from '../components/TestClickForm'

/**
 * Route definition for the test page.
 */
export const Route = createFileRoute('/test')({
  component: TestPage,
})

/**
 * Test click generation interface.
 * Provides forms for sending test clicks and documentation.
 *
 * @returns Test form and usage instructions
 */
function TestPage() {
  const { ads, campaigns, fetchAds, fetchCampaigns, refreshAll } = useDashboardStore()

  useEffect(() => {
    fetchAds()
    fetchCampaigns()
  }, [fetchAds, fetchCampaigns])

  const adsWithCampaign = ads.map((ad) => ({
    id: ad.id,
    campaign_id: ad.campaign_id,
    name: ad.name,
  }))

  const campaignsWithAdvertiser = campaigns.map((c) => ({
    id: c.id,
    advertiser_id: c.advertiser_id,
    name: c.name,
  }))

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-gray-900">Test Click Generation</h1>

      <div className="grid gap-6 lg:grid-cols-2">
        <TestClickForm
          ads={adsWithCampaign}
          campaigns={campaignsWithAdvertiser}
          onSuccess={refreshAll}
        />

        <div className="space-y-4">
          <div className="rounded-lg border border-gray-200 bg-white p-6">
            <h3 className="mb-4 text-lg font-semibold text-gray-900">About Test Clicks</h3>
            <div className="space-y-3 text-sm text-gray-600">
              <p>
                Use this page to generate test click events and validate the aggregation system.
              </p>
              <p>
                <strong>Single Click:</strong> Sends one click with the selected parameters.
                Useful for testing specific scenarios.
              </p>
              <p>
                <strong>Batch Clicks:</strong> Sends multiple clicks with randomized device types
                and countries. Useful for generating test data quickly.
              </p>
              <p>
                <strong>Fraud Detection:</strong> The system automatically flags clicks that
                appear suspicious based on rate limits and patterns.
              </p>
            </div>
          </div>

          <div className="rounded-lg border border-yellow-200 bg-yellow-50 p-6">
            <h3 className="mb-2 font-semibold text-yellow-800">Testing Tips</h3>
            <ul className="list-inside list-disc space-y-1 text-sm text-yellow-700">
              <li>Send many clicks quickly to trigger fraud detection</li>
              <li>Check the Dashboard to see real-time updates</li>
              <li>Use Analytics to query historical data</li>
              <li>View Recent Clicks to see individual events</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  )
}
