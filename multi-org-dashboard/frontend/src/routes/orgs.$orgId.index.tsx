import { useQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { ModuleGate } from '@/components/access'
import { ErrorNote, Loading, PageHeader, StatusBadge } from '@/components/shared'
import { useOrg } from '@/hooks/useOrg'
import { number, timeAgo } from '@/lib/format'
import { keys } from '@/lib/keys'
import { api } from '@/services/api'

export const Route = createFileRoute('/orgs/$orgId/')({
  component: () => (
    <ModuleGate module="overview">
      <OverviewPage />
    </ModuleGate>
  ),
})

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="card p-4">
      <p className="label">{label}</p>
      <p className="text-2xl font-semibold text-slate-900">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-slate-500">{hint}</p>}
    </div>
  )
}

function OverviewPage() {
  const { orgId, manifest } = useOrg()
  const { data, error, isPending } = useQuery({ queryKey: keys.overview(orgId), queryFn: ({ signal }) => api.overview(orgId, signal) })
  return (
    <div className="max-w-5xl">
      <PageHeader title={manifest.org.name} description={`You're signed in as ${manifest.role}. Projects you can see: ${manifest.projects.map((p) => p.name).join(', ')}.`} />
      {isPending && <Loading />}
      {error && <ErrorNote error={error} />}
      {data && (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="Agents" value={number(data.stats.agents)} hint={`${data.stats.liveAgents} live`} />
            <Stat label="Conversations (7d)" value={number(data.stats.conversations7d)} />
            <Stat label="Escalated (7d)" value={number(data.stats.escalated7d)} />
            <Stat label="Knowledge docs" value={number(data.stats.docs)} />
          </div>
          <div className="card mt-6">
            <div className="border-b border-slate-100 px-4 py-3 text-sm font-medium">Latest conversations</div>
            <ul className="divide-y divide-slate-100">
              {data.recent.map((c) => (
                <li key={c.id}>
                  <Link
                    to="/orgs/$orgId/conversations/$conversationId"
                    params={{ orgId, conversationId: c.id }}
                    className="flex items-center gap-3 px-4 py-2.5 text-sm hover:bg-slate-50"
                  >
                    <StatusBadge status={c.status} />
                    <span className="flex-1 truncate">{c.subject}</span>
                    <span className="text-xs text-slate-500">{c.agentName}</span>
                    <span className="w-16 text-right text-xs text-slate-400">{timeAgo(c.startedAt)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
    </div>
  )
}
