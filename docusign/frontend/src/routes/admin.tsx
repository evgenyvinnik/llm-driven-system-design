import { createFileRoute, useNavigate, Link } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { useAuthStore } from '../stores/authStore'
import { adminApi } from '../services/api'
import { AdminStats, Envelope, User, EmailNotification } from '../types'

function AdminPage() {
  const { user, isAuthenticated, isLoading: authLoading } = useAuthStore()
  const navigate = useNavigate()

  const [activeTab, setActiveTab] = useState<'overview' | 'users' | 'envelopes' | 'emails'>('overview')
  const [stats, setStats] = useState<AdminStats | null>(null)
  const [users, setUsers] = useState<User[]>([])
  const [envelopes, setEnvelopes] = useState<Envelope[]>([])
  const [emails, setEmails] = useState<EmailNotification[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!authLoading && (!isAuthenticated || user?.role !== 'admin')) {
      navigate({ to: '/' })
    }
  }, [isAuthenticated, authLoading, user, navigate])

  useEffect(() => {
    if (isAuthenticated && user?.role === 'admin') {
      loadData()
    }
  }, [isAuthenticated, user, activeTab])

  async function loadData() {
    setLoading(true)
    try {
      if (activeTab === 'overview') {
        const data = await adminApi.stats()
        setStats(data)
      } else if (activeTab === 'users') {
        const data = await adminApi.listUsers()
        setUsers(data.users)
      } else if (activeTab === 'envelopes') {
        const data = await adminApi.listEnvelopes()
        setEnvelopes(data.envelopes)
      } else if (activeTab === 'emails') {
        const data = await adminApi.getEmails()
        setEmails(data.emails)
      }
    } catch (error) {
      console.error('Failed to load admin data:', error)
    } finally {
      setLoading(false)
    }
  }

  async function handleUpdateRole(userId: string, newRole: 'user' | 'admin') {
    if (!confirm(`Change this user's role to ${newRole}?`)) return

    try {
      await adminApi.updateUserRole(userId, newRole)
      setUsers((prev) =>
        prev.map((u) => (u.id === userId ? { ...u, role: newRole } : u))
      )
    } catch (error) {
      alert((error as Error).message)
    }
  }

  if (authLoading || loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-8 h-8 border-4 border-gray-300 border-t-docusign-blue rounded-full spinner" />
      </div>
    )
  }

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <h1 className="text-2xl font-bold text-gray-900 mb-6">Admin Dashboard</h1>

      {/* Tabs */}
      <div className="border-b mb-6">
        <nav className="flex space-x-8">
          {['overview', 'users', 'envelopes', 'emails'].map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab as typeof activeTab)}
              className={`py-4 px-1 border-b-2 font-medium text-sm ${
                activeTab === tab
                  ? 'border-docusign-blue text-docusign-blue'
                  : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              {tab.charAt(0).toUpperCase() + tab.slice(1)}
            </button>
          ))}
        </nav>
      </div>

      {/* Tab content */}
      {activeTab === 'overview' && stats && <OverviewTab stats={stats} />}
      {activeTab === 'users' && <UsersTab users={users} onUpdateRole={handleUpdateRole} />}
      {activeTab === 'envelopes' && <EnvelopesTab envelopes={envelopes} />}
      {activeTab === 'emails' && <EmailsTab emails={emails} />}
    </div>
  )
}

function OverviewTab({ stats }: { stats: AdminStats }) {
  return (
    <div className="space-y-6">
      {/* Envelope stats */}
      <div className="bg-white rounded-lg shadow p-6">
        <h2 className="text-lg font-semibold mb-4">Envelope Statistics</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <StatCard label="Total" value={stats.envelopes.total} color="bg-blue-100 text-blue-800" />
          <StatCard label="Draft" value={stats.envelopes.draft} color="bg-gray-100 text-gray-800" />
          <StatCard label="Pending" value={stats.envelopes.pending} color="bg-yellow-100 text-yellow-800" />
          <StatCard label="Completed" value={stats.envelopes.completed} color="bg-green-100 text-green-800" />
          <StatCard label="Declined" value={stats.envelopes.declined} color="bg-red-100 text-red-800" />
          <StatCard label="Voided" value={stats.envelopes.voided} color="bg-gray-100 text-gray-800" />
          <StatCard label="Last 24h" value={stats.envelopes.last_24h} color="bg-purple-100 text-purple-800" />
          <StatCard label="Last 7d" value={stats.envelopes.last_7d} color="bg-indigo-100 text-indigo-800" />
        </div>
      </div>

      {/* User stats */}
      <div className="bg-white rounded-lg shadow p-6">
        <h2 className="text-lg font-semibold mb-4">User Statistics</h2>
        <div className="grid grid-cols-3 gap-4">
          <StatCard label="Total Users" value={stats.users.total} color="bg-blue-100 text-blue-800" />
          <StatCard label="Admins" value={stats.users.admins} color="bg-purple-100 text-purple-800" />
          <StatCard label="New (24h)" value={stats.users.new_24h} color="bg-green-100 text-green-800" />
        </div>
      </div>

      {/* Signature stats */}
      <div className="bg-white rounded-lg shadow p-6">
        <h2 className="text-lg font-semibold mb-4">Signature Statistics</h2>
        <div className="grid grid-cols-4 gap-4">
          <StatCard label="Total" value={stats.signatures.total} color="bg-blue-100 text-blue-800" />
          <StatCard label="Drawn" value={stats.signatures.drawn} color="bg-amber-100 text-amber-800" />
          <StatCard label="Typed" value={stats.signatures.typed} color="bg-teal-100 text-teal-800" />
          <StatCard label="Last 24h" value={stats.signatures.last_24h} color="bg-purple-100 text-purple-800" />
        </div>
      </div>

      {/* Document stats */}
      <div className="bg-white rounded-lg shadow p-6">
        <h2 className="text-lg font-semibold mb-4">Document Statistics</h2>
        <div className="grid grid-cols-3 gap-4">
          <StatCard label="Total Documents" value={stats.documents.total} color="bg-blue-100 text-blue-800" />
          <StatCard
            label="Total Size"
            value={`${Math.round(Number(stats.documents.total_size) / 1024 / 1024)} MB`}
            color="bg-green-100 text-green-800"
          />
          <StatCard
            label="Avg Pages"
            value={Math.round(Number(stats.documents.avg_pages)).toString()}
            color="bg-purple-100 text-purple-800"
          />
        </div>
      </div>
    </div>
  )
}

function StatCard({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div className={`${color} rounded-lg p-4`}>
      <div className="text-2xl font-bold">{value}</div>
      <div className="text-sm">{label}</div>
    </div>
  )
}

function UsersTab({
  users,
  onUpdateRole,
}: {
  users: (User & { envelope_count?: number })[]
  onUpdateRole: (id: string, role: 'user' | 'admin') => void
}) {
  return (
    <div className="bg-white rounded-lg shadow overflow-hidden">
      <table className="min-w-full divide-y divide-gray-200">
        <thead className="bg-gray-50">
          <tr>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Name</th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Email</th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Role</th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Envelopes</th>
            <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-200">
          {users.map((user) => (
            <tr key={user.id}>
              <td className="px-6 py-4 whitespace-nowrap font-medium">{user.name}</td>
              <td className="px-6 py-4 whitespace-nowrap text-gray-500">{user.email}</td>
              <td className="px-6 py-4 whitespace-nowrap">
                <span
                  className={`px-2 py-1 rounded-full text-xs font-medium ${
                    user.role === 'admin' ? 'bg-purple-100 text-purple-800' : 'bg-gray-100 text-gray-800'
                  }`}
                >
                  {user.role}
                </span>
              </td>
              <td className="px-6 py-4 whitespace-nowrap text-gray-500">{user.envelope_count || 0}</td>
              <td className="px-6 py-4 whitespace-nowrap text-right">
                <button
                  onClick={() => onUpdateRole(user.id, user.role === 'admin' ? 'user' : 'admin')}
                  className="text-docusign-blue hover:text-docusign-dark text-sm"
                >
                  {user.role === 'admin' ? 'Demote' : 'Promote'}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function EnvelopesTab({ envelopes }: { envelopes: (Envelope & { sender_name?: string })[] }) {
  return (
    <div className="bg-white rounded-lg shadow overflow-hidden">
      <table className="min-w-full divide-y divide-gray-200">
        <thead className="bg-gray-50">
          <tr>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Name</th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Sender</th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Created</th>
            <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-200">
          {envelopes.map((envelope) => (
            <tr key={envelope.id}>
              <td className="px-6 py-4 whitespace-nowrap font-medium">{envelope.name}</td>
              <td className="px-6 py-4 whitespace-nowrap text-gray-500">{envelope.sender_name}</td>
              <td className="px-6 py-4 whitespace-nowrap">
                <StatusBadge status={envelope.status} />
              </td>
              <td className="px-6 py-4 whitespace-nowrap text-gray-500">
                {new Date(envelope.created_at).toLocaleDateString()}
              </td>
              <td className="px-6 py-4 whitespace-nowrap text-right">
                <Link
                  to="/envelopes/$envelopeId"
                  params={{ envelopeId: envelope.id }}
                  className="text-docusign-blue hover:text-docusign-dark text-sm"
                >
                  View
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function EmailsTab({ emails }: { emails: EmailNotification[] }) {
  return (
    <div className="bg-white rounded-lg shadow p-6">
      <h2 className="text-lg font-semibold mb-4">Recent Emails (Simulated)</h2>
      <div className="space-y-4">
        {emails.map((email) => (
          <div key={email.id} className="border rounded-lg p-4">
            <div className="flex justify-between items-start mb-2">
              <div>
                <span className="font-medium">{email.subject}</span>
                <span className="text-gray-500 text-sm ml-2">
                  to {email.recipient_name || email.recipient_email}
                </span>
              </div>
              <span className="text-xs text-gray-400">
                {new Date(email.created_at).toLocaleString()}
              </span>
            </div>
            <div className="text-sm text-gray-600 whitespace-pre-wrap">{email.body}</div>
            <div className="mt-2">
              <span
                className={`text-xs px-2 py-1 rounded ${
                  email.status === 'sent' ? 'bg-green-100 text-green-800' : 'bg-yellow-100 text-yellow-800'
                }`}
              >
                {email.status}
              </span>
              <span className="text-xs text-gray-500 ml-2">{email.type}</span>
            </div>
          </div>
        ))}
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

export const Route = createFileRoute('/admin')({
  component: AdminPage,
})
