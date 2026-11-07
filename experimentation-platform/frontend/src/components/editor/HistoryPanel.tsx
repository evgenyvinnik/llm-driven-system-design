import { pctBuckets, timeAgo } from '@/lib/format'
import { usePoll } from '@/lib/use-poll'
import { api } from '@/services/api'
import type { Flag } from '@/types'

export function HistoryPanel({ flag, env, refreshKey }: { flag: Flag; env: string; refreshKey: number }) {
  const { data } = usePoll(() => Promise.all([api.versions(flag.key, env), api.audit({ flag: flag.key, env, limit: 12 })]), 10_000, [flag.key, env, refreshKey])
  const [versions, audit] = data ?? [null, null]
  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
      <section className="card p-4" aria-label="Version history">
        <h2 className="panel-title mb-2">Config versions ({env})</h2>
        <table className="w-full text-xs" aria-label="Versions">
          <tbody className="divide-y divide-slate-100">
            {versions?.versions.map((v) => (
              <tr key={v.version}>
                <td className="num py-1.5 pr-2 font-semibold">v{v.version}</td>
                <td className="pr-2">{v.status}</td>
                <td className="num pr-2 text-slate-600">
                  {Object.entries(v.weights)
                    .map(([k, w]) => `${k} ${pctBuckets(w)}`)
                    .join(' · ') || '—'}
                </td>
                <td className="pr-2 text-slate-500">{v.ruleCount} rules</td>
                <td className="text-right text-slate-400">
                  {v.changedBy} · {timeAgo(v.changedAt)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <section className="card p-4" aria-label="Recent changes">
        <h2 className="panel-title mb-2">Audit log for {flag.key}</h2>
        <ul className="space-y-2 text-xs">
          {audit?.entries.map((e) => (
            <li key={e.id} className="flex gap-2">
              <span className={`chip shrink-0 ${e.action === 'kill_switch' ? 'bg-rose-100 text-rose-800' : 'bg-slate-100 text-slate-600'}`}>{e.action}</span>
              <span className="text-slate-700">{e.summary}</span>
              <span className="ml-auto shrink-0 text-slate-400">
                {e.actor} · {timeAgo(e.at)}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}
