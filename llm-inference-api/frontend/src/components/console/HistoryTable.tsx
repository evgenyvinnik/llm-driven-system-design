import { Link } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { LatencyBar } from '@/components/shared/LatencyBar'
import { ClassChip, StatusChip } from '@/components/shared/StatusChip'
import { clock, int, ms } from '@/lib/format'
import { api } from '@/services/api'
import { useConsoleStore } from '@/stores/console-store'
import type { RequestRecord } from '@/types'

export function HistoryTable() {
  const version = useConsoleStore((s) => s.historyVersion)
  const loadOrgs = useConsoleStore((s) => s.loadOrgs)
  const [rows, setRows] = useState<RequestRecord[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    const load = () =>
      api
        .requests({ limit: 25 })
        .then((r) => alive && (setRows(r.requests), setError(null)))
        .catch((e: Error) => alive && setError(e.message))
    void load()
    void loadOrgs().catch(() => undefined)
    const t = setInterval(load, 5000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [version, loadOrgs])

  return (
    <section className="card overflow-hidden" aria-label="Request history">
      <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2.5">
        <h2 className="panel-title">Request history</h2>
        <span className="text-xs text-slate-500">Your orgs · latest 25 · usage and the latency split per request</span>
      </div>
      {error && <p className="px-4 py-2 text-sm text-red-700">{error}</p>}
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-slate-100" aria-label="Requests">
          <thead className="bg-slate-50">
            <tr>
              <th className="th">Time</th>
              <th className="th">Request</th>
              <th className="th">Key</th>
              <th className="th">Mode</th>
              <th className="th">Status</th>
              <th className="th">Backend</th>
              <th className="th text-right">In (cached) / out</th>
              <th className="th">Queue · first token · total</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows?.map((r) => (
              <tr key={r.id} className="hover:bg-slate-50">
                <td className="td num whitespace-nowrap text-xs">{clock(r.createdAt)}</td>
                <td className="td">
                  <Link to="/requests/$requestId" params={{ requestId: r.id }} className="font-mono text-xs text-accent-700 hover:underline">
                    {r.id}
                  </Link>
                </td>
                <td className="td whitespace-nowrap text-xs">
                  {r.orgName} / {r.keyName}
                </td>
                <td className="td whitespace-nowrap text-xs">
                  {r.mode} <ClassChip cls={r.priorityClass} />
                </td>
                <td className="td">
                  <StatusChip status={r.status} />
                </td>
                <td className="td text-xs">{r.backendId ?? '–'}{r.attempts > 1 ? ` (${r.attempts} tries)` : ''}</td>
                <td className="td num text-right text-xs">
                  {r.usage ? `${int(r.usage.inputTokens)} (${int(r.usage.cachedInputTokens)}) / ${int(r.usage.outputTokens)}` : '–'}
                </td>
                <td className="td">
                  {r.usage ? (
                    <div className="flex items-center gap-2">
                      <LatencyBar compact queueMs={r.usage.queueMs} ttftMs={r.usage.ttftMs} execMs={r.usage.execMs} />
                      <span className="num whitespace-nowrap text-xs text-slate-500">
                        {ms(r.usage.queueMs)} · {ms(r.usage.ttftMs)} · {ms(r.usage.totalMs)}
                      </span>
                    </div>
                  ) : (
                    <span className="text-xs text-slate-400">–</span>
                  )}
                </td>
              </tr>
            ))}
            {rows?.length === 0 && (
              <tr>
                <td className="td text-slate-500" colSpan={8}>No requests yet.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  )
}
