import { createFileRoute } from '@tanstack/react-router'
import { ClientsTable } from '@/components/clients/ClientsTable'
import { RadioIcon, ServerIcon } from '@/components/icons'
import { Loading } from '@/components/shared/Loading'
import { dateTime } from '@/lib/format'
import { usePoll } from '@/lib/use-poll'
import { api } from '@/services/api'
import { useEnvStore } from '@/stores/env-store'

export const Route = createFileRoute('/clients')({ component: ClientsPage })

/** Polls every second (the console itself never holds a stream open). */
function ClientsPage() {
  const env = useEnvStore((s) => s.env)
  const { data, error } = usePoll(() => Promise.all([api.clients(env), api.system()]), 1000, [env])
  if (!data) return error ? <main className="page text-sm text-rose-700">{error}</main> : <Loading />
  const [view, system] = data
  const connected = view.clients.filter((c) => c.connected).length
  return (
    <div className="page">
      <div>
        <h1 className="h1 flex items-center gap-2">
          <RadioIcon className="h-5 w-5 text-accent-600" /> Live SDK clients
        </h1>
        <p className="text-sm text-slate-500">
          Every SDK reports the snapshot version it has applied. Pull a kill switch and watch each client move to the new version; the latency is publish → the client’s report.
        </p>
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div className="card p-3">
          <div className="panel-title">Latest snapshot ({env})</div>
          <div className="num mt-1 text-2xl font-semibold" data-testid="latest-version">
            v{view.latestVersion}
          </div>
        </div>
        <div className="card p-3">
          <div className="panel-title">Clients</div>
          <div className="num mt-1 text-2xl font-semibold">
            {view.clients.length} <span className="text-sm font-normal text-slate-500">({connected} streaming)</span>
          </div>
        </div>
        <div className="card p-3">
          <div className="panel-title">API instance answering</div>
          <div className="mt-1 flex items-center gap-1.5 text-lg font-semibold">
            <ServerIcon className="h-4 w-4 text-slate-400" /> {system.instanceId}
          </div>
        </div>
        <div className="card p-3">
          <div className="panel-title">Ingest worker</div>
          <div className="mt-1 text-sm">{system.worker ? <span className="num">lag {system.worker.lag} · {system.worker.rowsTotal.toLocaleString()} rows</span> : <span className="text-slate-400">no heartbeat</span>}</div>
        </div>
      </div>
      <ClientsTable clients={view.clients} latest={view.latestVersion} />
      <section className="card p-4" aria-label="Recent snapshots">
        <h2 className="panel-title mb-2">Recent snapshots ({env})</h2>
        <table className="w-full text-xs" aria-label="Snapshots">
          <tbody className="divide-y divide-slate-100">
            {view.snapshots.map((s) => (
              <tr key={s.version}>
                <td className="num py-1.5 pr-3 font-semibold">v{s.version}</td>
                <td className={`pr-3 ${s.reason.startsWith('KILL') ? 'font-semibold text-rose-700' : 'text-slate-700'}`}>{s.reason}</td>
                <td className="num pr-3 text-slate-500">
                  {s.flagCount} flags · {(s.bytes / 1024).toFixed(1)} KB
                </td>
                <td className="text-right text-slate-400">{dateTime(s.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  )
}
