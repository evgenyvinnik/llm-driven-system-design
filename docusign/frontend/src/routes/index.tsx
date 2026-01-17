import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { useAuthStore } from '../stores/authStore'
import { envelopeApi } from '../services/api'
import { Envelope } from '../types'

function DashboardPage() {
  const { isAuthenticated, isLoading: authLoading } = useAuthStore()
  const navigate = useNavigate()
  const [stats, setStats] = useState<Record<string, string>>({})
  const [recentEnvelopes, setRecentEnvelopes] = useState<Envelope[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!authLoading && !isAuthenticated) {
      navigate({ to: '/login' })
    }
  }, [isAuthenticated, authLoading, navigate])

  useEffect(() => {
    if (isAuthenticated) {
      loadDashboard()
    }
  }, [isAuthenticated])

  async function loadDashboard() {
    try {
      setLoading(true)
      const [statsRes, envelopesRes] = await Promise.all([
        envelopeApi.stats(),
        envelopeApi.list(undefined, 1, 5),
      ])
      setStats(statsRes.stats)
      setRecentEnvelopes(envelopesRes.envelopes)
    } catch (error) {
      console.error('Failed to load dashboard:', error)
    } finally {
      setLoading(false)
    }
  }

  if (authLoading || loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-8 h-8 border-4 border-gray-300 border-t-docusign-blue rounded-full spinner" />
      </div>
    )
  }

  const statCards = [
    { label: 'Draft', value: stats.draft || '0', color: 'bg-gray-100 text-gray-800' },
    { label: 'Pending', value: stats.pending || '0', color: 'bg-yellow-100 text-yellow-800' },
    { label: 'Completed', value: stats.completed || '0', color: 'bg-green-100 text-green-800' },
    { label: 'Declined', value: stats.declined || '0', color: 'bg-red-100 text-red-800' },
  ]

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="flex justify-between items-center mb-8">
        <h1 className="text-2xl font-bold text-gray-900">Dashboard</h1>
        <Link
          to="/envelopes/new"
          className="bg-docusign-blue text-white px-4 py-2 rounded-lg font-medium hover:bg-docusign-dark"
        >
          New Envelope
        </Link>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
        {statCards.map((stat) => (
          <div key={stat.label} className={`${stat.color} rounded-lg p-4`}>
            <div className="text-3xl font-bold">{stat.value}</div>
            <div className="text-sm">{stat.label}</div>
          </div>
        ))}
      </div>

      {/* Recent Envelopes */}
      <div className="bg-white rounded-lg shadow">
        <div className="px-6 py-4 border-b flex justify-between items-center">
          <h2 className="text-lg font-semibold">Recent Envelopes</h2>
          <Link to="/envelopes" className="text-docusign-blue text-sm hover:underline">
            View all
          </Link>
        </div>
        <div className="divide-y">
          {recentEnvelopes.length === 0 ? (
            <div className="px-6 py-8 text-center text-gray-500">
              No envelopes yet.{' '}
              <Link to="/envelopes/new" className="text-docusign-blue hover:underline">
                Create your first envelope
              </Link>
            </div>
          ) : (
            recentEnvelopes.map((envelope) => (
              <Link
                key={envelope.id}
                to="/envelopes/$envelopeId"
                params={{ envelopeId: envelope.id }}
                className="block px-6 py-4 hover:bg-gray-50"
              >
                <div className="flex items-center justify-between">
                  <div>
                    <div className="font-medium text-gray-900">{envelope.name}</div>
                    <div className="text-sm text-gray-500">
                      {new Date(envelope.created_at).toLocaleDateString()}
                    </div>
                  </div>
                  <StatusBadge status={envelope.status} />
                </div>
              </Link>
            ))
          )}
        </div>
      </div>
    </div>
  )
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    draft: 'bg-gray-100 text-gray-800',
    sent: 'bg-blue-100 text-blue-800',
    delivered: 'bg-blue-100 text-blue-800',
    signed: 'bg-yellow-100 text-yellow-800',
    completed: 'bg-green-100 text-green-800',
    declined: 'bg-red-100 text-red-800',
    voided: 'bg-gray-100 text-gray-800',
  }

  return (
    <span className={`px-2 py-1 rounded-full text-xs font-medium ${colors[status] || 'bg-gray-100'}`}>
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </span>
  )
}

export const Route = createFileRoute('/')({
  component: DashboardPage,
})
