import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { EvalPanel, IndexPanel, ModelPanel, StatTile, TurnTrace } from '@/components/admin'
import { ShieldIcon } from '@/components/icons'
import { Loading } from '@/components/shared/Loading'
import { compact, percent, relativeTime, seconds } from '@/lib/format'
import { api } from '@/services/api'
import type { AdminOverview, AdminTurn } from '@/types'

export const Route = createFileRoute('/admin')({
  validateSearch: (search: Record<string, unknown>): { turn?: string } => ({ turn: typeof search.turn === 'string' ? search.turn : undefined }),
  component: AdminPage,
})

const STATUS_STYLE: Record<string, string> = {
  completed: 'bg-emerald-50 text-emerald-700',
  failed: 'bg-red-50 text-red-700',
  cancelled: 'bg-slate-100 text-slate-600',
  running: 'bg-sky-50 text-sky-700',
  waiting_client: 'bg-violet-50 text-violet-700',
  waiting_confirmation: 'bg-amber-50 text-amber-700',
}

function AdminPage() {
  const { turn } = Route.useSearch()
  const navigate = useNavigate()
  const [overview, setOverview] = useState<AdminOverview | null>(null)
  const [turns, setTurns] = useState<AdminTurn[] | null>(null)
  useEffect(() => {
    const load = () => {
      api.adminOverview().then(setOverview).catch(() => undefined)
      api.adminTurns().then((r) => setTurns(r.turns)).catch(() => undefined)
    }
    load()
    const timer = setInterval(load, 5000)
    return () => clearInterval(timer)
  }, [])
  if (!overview || !turns) return <Loading />
  const total = Object.values(overview.turnsByStatus).reduce((a, b) => a + b, 0)
  const kept = overview.feedback.edit_kept ?? 0
  const undone = overview.feedback.edit_undone ?? 0
  const sent = overview.feedback.draft_sent ?? 0
  const discarded = overview.feedback.draft_discarded ?? 0
  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="mb-4 flex items-baseline gap-3">
        <h1 className="text-xl font-semibold text-slate-900">Assistant operations</h1>
        <span className="text-xs text-slate-400">{overview.model.provider} · primary {overview.model.primary} · fallback {overview.model.fallback} · instance {overview.instance.id}</span>
      </div>
      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
        <StatTile label="Turns (24h)" value={String(total)} hint={`${overview.turnsByStatus.completed ?? 0} completed · ${overview.turnsByStatus.failed ?? 0} failed`} />
        <StatTile label="Active time p50" value={seconds(overview.activeMs.p50)} hint={`p95 ${seconds(overview.activeMs.p95)}`} />
        <StatTile label="Model calls / turn" value={overview.avgSteps?.toFixed(1) ?? '—'} />
        <StatTile label="Cache hit rate" value={percent(overview.tokens.cacheHitRate)} hint={`${compact(overview.tokens.cacheRead)} of ${compact(overview.tokens.input)} input tokens`} />
        <StatTile label="Confirmations" value={String(Object.values(overview.confirmations).reduce((a, b) => a + b, 0))} hint={`${overview.confirmations.approved ?? 0} approved · ${overview.confirmations.declined ?? 0} declined · ${overview.confirmations.expired ?? 0} expired`} />
        <StatTile label="AI edits kept" value={kept + undone ? percent(kept / (kept + undone)) : '—'} hint={`${kept} kept · ${undone} undone (7d)`} />
        <StatTile label="AI drafts sent" value={sent + discarded ? percent(sent / (sent + discarded)) : '—'} hint={`${sent} sent · ${discarded} discarded (7d)`} />
      </div>
      <div className="grid gap-5 xl:grid-cols-[1fr_380px]">
        <div className="space-y-5">
          <section className="card overflow-hidden">
            <div className="panel-title border-b border-slate-200 px-3 py-2">Recent turns</div>
            <table className="w-full text-xs">
              <thead className="bg-slate-50 text-left text-[10px] uppercase tracking-wide text-slate-500">
                <tr><th className="px-3 py-1.5">Request</th><th>App</th><th>Status</th><th className="text-right">Calls</th><th className="text-right">Tokens</th><th className="text-right">Cached</th><th className="text-right">Active</th><th className="px-3 text-right">When</th></tr>
              </thead>
              <tbody>
                {turns.map((t) => (
                  <tr key={t.id} className="cursor-pointer border-t border-slate-100 hover:bg-slate-50" onClick={() => void navigate({ to: '/admin', search: { turn: t.id } })}>
                    <td className="max-w-[320px] truncate px-3 py-1.5 text-slate-800">
                      {t.tainted && <ShieldIcon className="mr-1 inline h-3 w-3 text-amber-600" />}
                      <span className="text-slate-400">{t.user.split(' ')[0]}:</span> {t.userText}
                    </td>
                    <td className="text-slate-500">{t.app}</td>
                    <td><span className={`chip ${STATUS_STYLE[t.status]}`}>{t.status.replace('_', ' ')}</span></td>
                    <td className="text-right tabular-nums">{t.steps}</td>
                    <td className="text-right tabular-nums">{compact(t.inputTokens + t.outputTokens)}</td>
                    <td className="text-right tabular-nums text-slate-500">{t.inputTokens ? percent(t.cacheReadTokens / t.inputTokens) : '—'}</td>
                    <td className="text-right tabular-nums text-slate-500">{seconds(t.activeMs)}</td>
                    <td className="px-3 text-right text-slate-400">{relativeTime(t.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          <div className="grid gap-5 lg:grid-cols-2">
            <section className="card p-3">
              <div className="panel-title mb-2">Tools (24h)</div>
              <table className="w-full text-xs">
                <tbody>
                  {overview.tools.map((t) => (
                    <tr key={t.name}><td className="py-0.5 font-mono text-slate-700">{t.name}</td><td className="text-right tabular-nums">{t.calls} calls</td><td className="text-right tabular-nums text-slate-500">{t.errors} errors</td><td className="text-right tabular-nums text-slate-400">{t.p50Ms !== null ? `${Math.round(t.p50Ms)}ms` : ''}</td></tr>
                  ))}
                </tbody>
              </table>
            </section>
            <section className="card p-3">
              <div className="panel-title mb-2">Policy decisions (24h)</div>
              <table className="w-full text-xs">
                <tbody>
                  {overview.policy.map((p) => (
                    <tr key={`${p.action}-${p.rule}`}><td className="py-0.5 text-slate-700">{p.rule}</td><td className="text-slate-500">{p.action}</td><td className="text-right tabular-nums">{p.count}</td></tr>
                  ))}
                </tbody>
              </table>
            </section>
          </div>
          <EvalPanel />
        </div>
        <div className="space-y-5">
          <ModelPanel />
          <IndexPanel />
        </div>
      </div>
      {turn && <TurnTrace turnId={turn} onClose={() => void navigate({ to: '/admin', search: {} })} />}
    </div>
  )
}
