import { createFileRoute } from '@tanstack/react-router'
import { BackendCard } from '@/components/admin/BackendCard'
import { BatchPanel } from '@/components/admin/BatchPanel'
import { ConfigPanel } from '@/components/admin/ConfigPanel'
import { LatencyPanel } from '@/components/admin/LatencyPanel'
import { QueuePanel } from '@/components/admin/QueuePanel'
import { UsageTable } from '@/components/admin/UsageTable'
import { Loading } from '@/components/shared/Loading'
import { usePoll } from '@/lib/use-poll'
import { api } from '@/services/api'
import { useAuthStore } from '@/stores/auth-store'

export const Route = createFileRoute('/admin')({ component: AdminPage })

function AdminPage() {
  const isAdmin = useAuthStore((s) => s.user?.isAdmin === true)
  if (!isAdmin) return <main className="mx-auto max-w-7xl px-4 py-6 text-sm text-slate-600">The admin console is for platform operators.</main>
  return <AdminConsole />
}

function AdminConsole() {
  // Short polling (1 s) of one snapshot: no long-lived connection, survives proxies,
  // and the data is an aggregate of several stores, not a stream of events.
  const { data, error, updatedAt, refresh } = usePoll(api.overview, 1000)
  if (!data) return error ? <main className="mx-auto max-w-7xl px-4 py-6 text-sm text-red-700">{error}</main> : <Loading />

  return (
    <main className="mx-auto max-w-7xl space-y-4 px-4 py-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Admin console</h1>
          <p className="text-sm text-slate-500">
            Dispatcher leader <span className="font-mono">{data.dispatcher.leader ?? 'none'}</span> · {data.dispatcher.inflight} in flight
          </p>
        </div>
        <span className={`text-xs ${error ? 'text-red-700' : 'text-slate-400'}`}>
          {error ? `Stale: ${error}` : `Updated ${updatedAt ? new Date(updatedAt).toLocaleTimeString('en-US', { hour12: false }) : ''} · polling every second`}
        </span>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <QueuePanel queues={data.queues} open={data.open} />
        <BatchPanel batches={data.batches} maxSize={data.config.batchMaxSize} />
      </div>
      <section aria-label="Backends">
        <h2 className="panel-title mb-2">Model backends</h2>
        <div className="grid gap-4 md:grid-cols-3">
          {data.backends.map((b) => (
            <BackendCard key={b.id} b={b} onChange={() => void refresh()} />
          ))}
        </div>
      </section>
      <UsageTable usage={data.usage} />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <LatencyPanel latency={data.latency} />
        <ConfigPanel config={data.config} onChange={() => void refresh()} />
      </div>
    </main>
  )
}
