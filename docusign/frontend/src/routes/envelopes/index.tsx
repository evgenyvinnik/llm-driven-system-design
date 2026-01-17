import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { useAuthStore } from '../../stores/authStore'
import { useEnvelopeStore } from '../../stores/envelopeStore'

function EnvelopesListPage() {
  const { isAuthenticated, isLoading: authLoading } = useAuthStore()
  const { envelopes, isLoading, fetchEnvelopes, deleteEnvelope } = useEnvelopeStore()
  const navigate = useNavigate()
  const [statusFilter, setStatusFilter] = useState<string>('')

  useEffect(() => {
    if (!authLoading && !isAuthenticated) {
      navigate({ to: '/login' })
    }
  }, [isAuthenticated, authLoading, navigate])

  useEffect(() => {
    if (isAuthenticated) {
      fetchEnvelopes(statusFilter || undefined)
    }
  }, [isAuthenticated, statusFilter, fetchEnvelopes])

  async function handleDelete(id: string, name: string) {
    if (confirm(`Delete envelope "${name}"?`)) {
      try {
        await deleteEnvelope(id)
      } catch (error) {
        alert((error as Error).message)
      }
    }
  }

  if (authLoading || isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-8 h-8 border-4 border-gray-300 border-t-docusign-blue rounded-full spinner" />
      </div>
    )
  }

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Envelopes</h1>
        <Link
          to="/envelopes/new"
          className="bg-docusign-blue text-white px-4 py-2 rounded-lg font-medium hover:bg-docusign-dark"
        >
          New Envelope
        </Link>
      </div>

      {/* Filters */}
      <div className="mb-6">
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="px-3 py-2 border rounded-lg focus:ring-2 focus:ring-docusign-blue"
        >
          <option value="">All Status</option>
          <option value="draft">Draft</option>
          <option value="sent">Sent</option>
          <option value="delivered">Delivered</option>
          <option value="completed">Completed</option>
          <option value="declined">Declined</option>
          <option value="voided">Voided</option>
        </select>
      </div>

      {/* Envelope list */}
      <div className="bg-white rounded-lg shadow overflow-hidden">
        {envelopes.length === 0 ? (
          <div className="px-6 py-12 text-center text-gray-500">
            <p className="mb-4">No envelopes found.</p>
            <Link to="/envelopes/new" className="text-docusign-blue hover:underline">
              Create your first envelope
            </Link>
          </div>
        ) : (
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Name
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Status
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Recipients
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Created
                </th>
                <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {envelopes.map((envelope) => (
                <tr key={envelope.id} className="hover:bg-gray-50">
                  <td className="px-6 py-4 whitespace-nowrap">
                    <Link
                      to="/envelopes/$envelopeId"
                      params={{ envelopeId: envelope.id }}
                      className="text-docusign-blue hover:underline font-medium"
                    >
                      {envelope.name}
                    </Link>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <StatusBadge status={envelope.status} />
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                    {envelope.completed_count || 0}/{envelope.recipient_count || 0}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                    {new Date(envelope.created_at).toLocaleDateString()}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                    <Link
                      to="/envelopes/$envelopeId"
                      params={{ envelopeId: envelope.id }}
                      className="text-docusign-blue hover:text-docusign-dark mr-4"
                    >
                      View
                    </Link>
                    {envelope.status === 'draft' && (
                      <button
                        onClick={() => handleDelete(envelope.id, envelope.name)}
                        className="text-red-600 hover:text-red-900"
                      >
                        Delete
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
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

export const Route = createFileRoute('/envelopes/')({
  component: EnvelopesListPage,
})
