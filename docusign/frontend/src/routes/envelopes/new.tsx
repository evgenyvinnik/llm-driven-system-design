import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useState, useEffect } from 'react'
import { useAuthStore } from '../../stores/authStore'
import { useEnvelopeStore } from '../../stores/envelopeStore'

function NewEnvelopePage() {
  const { isAuthenticated, isLoading: authLoading } = useAuthStore()
  const { createEnvelope } = useEnvelopeStore()
  const navigate = useNavigate()

  const [name, setName] = useState('')
  const [message, setMessage] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!authLoading && !isAuthenticated) {
      navigate({ to: '/login' })
    }
  }, [isAuthenticated, authLoading, navigate])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')

    if (!name.trim()) {
      setError('Envelope name is required')
      return
    }

    setLoading(true)

    try {
      const envelope = await createEnvelope(name.trim(), message.trim() || undefined)
      navigate({ to: '/envelopes/$envelopeId', params: { envelopeId: envelope.id } })
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  if (authLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-8 h-8 border-4 border-gray-300 border-t-docusign-blue rounded-full spinner" />
      </div>
    )
  }

  return (
    <div className="max-w-2xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <h1 className="text-2xl font-bold text-gray-900 mb-6">Create New Envelope</h1>

      <div className="bg-white rounded-lg shadow p-6">
        {error && (
          <div className="bg-red-50 text-red-600 p-3 rounded-lg mb-4 text-sm">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-6">
          <div>
            <label htmlFor="name" className="block text-sm font-medium text-gray-700 mb-1">
              Envelope Name *
            </label>
            <input
              id="name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g., Employment Contract - John Doe"
              className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-docusign-blue focus:border-docusign-blue"
              required
            />
          </div>

          <div>
            <label htmlFor="message" className="block text-sm font-medium text-gray-700 mb-1">
              Message to Recipients (optional)
            </label>
            <textarea
              id="message"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Please review and sign this document at your earliest convenience."
              rows={4}
              className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-docusign-blue focus:border-docusign-blue"
            />
          </div>

          <div className="flex justify-end space-x-4">
            <button
              type="button"
              onClick={() => navigate({ to: '/envelopes' })}
              className="px-4 py-2 border rounded-lg text-gray-700 hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading}
              className="px-4 py-2 bg-docusign-blue text-white rounded-lg font-medium hover:bg-docusign-dark disabled:opacity-50"
            >
              {loading ? 'Creating...' : 'Create Envelope'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

export const Route = createFileRoute('/envelopes/new')({
  component: NewEnvelopePage,
})
