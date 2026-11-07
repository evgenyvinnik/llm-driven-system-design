import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { Loading } from '@/components/shared/Loading'
import { dateTime } from '@/lib/format'
import { usePoll } from '@/lib/use-poll'
import { api } from '@/services/api'
import { useEnvStore } from '@/stores/env-store'

export const Route = createFileRoute('/audit')({ component: AuditPage })

const ACTION_STYLE: Record<string, string> = {
  kill_switch: 'bg-rose-100 text-rose-800',
  status: 'bg-amber-100 text-amber-800',
  update_config: 'bg-accent-50 text-accent-700',
  create: 'bg-emerald-100 text-emerald-800',
}

function AuditPage() {
  const env = useEnvStore((s) => s.env)
  const [flag, setFlag] = useState('')
  const { data, error } = usePoll(() => api.audit({ env, flag: flag || undefined, limit: 200 }), 5000, [env, flag])
  return (
    <div className="page">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="h1">Audit log</h1>
          <p className="text-sm text-slate-500">Who changed what, written in the same transaction as the change. Config versions show the before/after version of the flag in that environment.</p>
        </div>
        <input className="input w-60 font-mono" placeholder="filter by flag key" value={flag} onChange={(e) => setFlag(e.target.value.trim())} aria-label="Filter by flag" />
      </div>
      {!data ? (
        error ? <p className="text-sm text-rose-700">{error}</p> : <Loading />
      ) : (
        <div className="card overflow-hidden">
          <table className="w-full" aria-label="Audit entries">
            <thead className="border-b border-slate-200 bg-slate-50">
              <tr>
                <th className="th">When</th>
                <th className="th">Who</th>
                <th className="th">Action</th>
                <th className="th">Flag</th>
                <th className="th">Env</th>
                <th className="th">Version</th>
                <th className="th">Change</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.entries.map((e) => (
                <tr key={e.id}>
                  <td className="td whitespace-nowrap text-xs text-slate-500">{dateTime(e.at)}</td>
                  <td className="td font-medium">{e.actor}</td>
                  <td className="td">
                    <span className={`chip ${ACTION_STYLE[e.action] ?? 'bg-slate-100 text-slate-600'}`}>{e.action}</span>
                  </td>
                  <td className="td font-mono text-xs">{e.flagKey}</td>
                  <td className="td text-xs">{e.environment ?? 'all'}</td>
                  <td className="td num whitespace-nowrap text-xs text-slate-500">{e.toVersion ? `v${e.fromVersion ?? '–'} → v${e.toVersion}` : '—'}</td>
                  <td className="td text-sm">{e.summary}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
