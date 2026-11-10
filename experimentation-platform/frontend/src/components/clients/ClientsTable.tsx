import { timeAgo } from '@/lib/format'
import type { LiveClient } from '@/types'

export function ClientsTable({ clients, latest }: { clients: LiveClient[]; latest: number }) {
  if (clients.length === 0) {
    return <p className="card p-6 text-center text-sm text-slate-500">No SDK clients connected. Open the demo storefront or run the traffic simulator.</p>
  }
  return (
    <div className="card overflow-hidden">
      <table className="w-full" aria-label="SDK clients">
        <thead className="border-b border-slate-200 bg-slate-50">
          <tr>
            <th className="th">Client</th>
            <th className="th">Connection</th>
            <th className="th">Snapshot held</th>
            <th className="th">Last update reached it in</th>
            <th className="th">Last seen</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {clients.map((c) => {
            const behind = latest - c.heldVersion
            const u = c.lastUpdate
            return (
              <tr key={c.sdkInstanceId} data-client={c.sdkInstanceId}>
                <td className="td">
                  <div className="font-medium text-slate-800">{c.label}</div>
                  <div className="font-mono text-[11px] text-slate-400">{c.sdkInstanceId}</div>
                </td>
                <td className="td">
                  <span className={`chip ${c.connected ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-600'}`}>{c.connected ? `SSE via ${c.apiInstance}` : `${c.transport === 'sse' ? 'reconnecting' : 'polling'}`}</span>
                </td>
                <td className="td num">
                  <span className="font-semibold">v{c.heldVersion}</span>{' '}
                  {behind <= 0 ? <span className="chip bg-emerald-50 text-emerald-700">current</span> : <span className="chip bg-amber-100 text-amber-800">{behind} behind</span>}
                  <div className="text-[11px] text-slate-400">from {c.source}</div>
                </td>
                <td className="td num">
                  {u?.latencyMs != null ? (
                    <>
                      <span className={`font-semibold ${u.reason === 'kill_switch' ? 'text-rose-700' : 'text-slate-800'}`}>{u.latencyMs < 1000 ? `${u.latencyMs} ms` : `${(u.latencyMs / 1000).toFixed(1)} s`}</span>
                      <span className="text-xs text-slate-500">
                        {' '}
                        (v{u.version}
                        {u.reason === 'kill_switch' ? ', kill switch' : ''})
                      </span>
                    </>
                  ) : (
                    <span className="text-xs text-slate-400">{u ? `v${u.version} at startup` : '—'}</span>
                  )}
                </td>
                <td className="td text-xs text-slate-500">{timeAgo(c.lastSeenAt)}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
