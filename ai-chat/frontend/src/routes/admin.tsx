import { useCallback, useEffect, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { formatMs, timeAgo } from '@/lib/format'
import { api } from '@/services/api'
import { useAuth } from '@/stores/auth-store'
import { useUi } from '@/stores/ui-store'
import type { AdminOverview, ModelSettings } from '@/types'

export const Route = createFileRoute('/admin')({ component: AdminPage })

const STATUS_STYLE: Record<string, string> = {
  completed: 'bg-emerald-50 text-emerald-700',
  running: 'bg-sky-50 text-sky-700',
  accepted: 'bg-slate-100 text-slate-600',
  cancelled: 'bg-amber-50 text-amber-700',
  failed: 'bg-red-50 text-red-700',
}

/** Operator view: generation health, plus knobs to make answers slow, fail, or disconnect on demand. */
function AdminPage() {
  const user = useAuth((s) => s.user)
  const [overview, setOverview] = useState<AdminOverview | null>(null)
  const [settings, setSettings] = useState<ModelSettings | null>(null)
  const [active, setActive] = useState(0)
  const [dropAfter, setDropAfter] = useState(0)

  const refresh = useCallback(async () => {
    const [o, s] = await Promise.all([api.adminOverview(), api.modelSettings()])
    setOverview(o)
    setSettings(s.settings)
    setActive(s.active)
    setDropAfter(s.streamDropAfterEvents)
  }, [])

  useEffect(() => {
    if (user?.role === 'admin') void refresh().catch((err) => useUi.getState().toast({ message: err.message, tone: 'error' }))
  }, [user, refresh])

  if (user?.role !== 'admin') {
    return <p className="p-6 text-sm text-slate-500">Operator access is required for this page.</p>
  }

  const update = async (patch: Partial<ModelSettings>) => {
    try {
      const s = await api.updateModelSettings(patch)
      setSettings(s.settings)
      setActive(s.active)
    } catch (err) {
      useUi.getState().toast({ message: (err as Error).message, tone: 'error' })
    }
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl space-y-6 p-6">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-semibold text-slate-900">Operator dashboard</h1>
          <button type="button" className="btn-secondary" onClick={() => void refresh()}>
            Refresh
          </button>
        </div>

        <section className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          {['completed', 'running', 'accepted', 'cancelled', 'failed'].map((status) => (
            <div key={status} className="card p-3">
              <div className="text-xs uppercase tracking-wide text-slate-500">{status}</div>
              <div className="mt-1 text-2xl font-semibold tabular-nums text-slate-900">{overview?.statusCounts[status] ?? 0}</div>
              <div className="text-[11px] text-slate-400">last 24 h</div>
            </div>
          ))}
        </section>

        <section className="card p-4">
          <h2 className="text-sm font-semibold text-slate-800">Failure and latency knobs</h2>
          <p className="mt-1 text-xs text-slate-500">
            Applied by the mock model service ({active} generation{active === 1 ? '' : 's'} streaming now) and by every API
            instance's stream handler. Use them to watch resume, Stop and error states in the chat.
          </p>
          {settings && (
            <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Knob
                label="Time to first token (ms)"
                hint="Empty = each model's default"
                value={settings.ttftMsOverride}
                onCommit={(v) => void update({ ttftMsOverride: v })}
              />
              <Knob
                label="Tokens per second"
                hint="Empty = each model's default"
                value={settings.tokensPerSecondOverride}
                onCommit={(v) => void update({ tokensPerSecondOverride: v })}
              />
              <Knob
                label="Failure rate (0–1)"
                hint="The model sends an error partway through"
                value={settings.failureRateOverride}
                step={0.05}
                onCommit={(v) => void update({ failureRateOverride: v })}
              />
              <Knob
                label="Model disconnect rate (0–1)"
                hint="The model drops the connection mid-answer, with no error"
                value={settings.disconnectRate}
                step={0.05}
                onCommit={(v) => void update({ disconnectRate: v ?? 0 })}
              />
              <Knob
                label="Concurrent generation slots"
                hint="Beyond this the model returns 429 and the executor backs off"
                value={settings.maxConcurrent}
                onCommit={(v) => void update({ maxConcurrent: v ?? 16 })}
              />
              <Knob
                label="Drop browser streams after N events"
                hint="0 = never. Clients must resume with Last-Event-ID"
                value={dropAfter}
                onCommit={(v) =>
                  void api
                    .setStreamDrop(v ?? 0)
                    .then((r) => setDropAfter(r.streamDropAfterEvents))
                    .catch((err) => useUi.getState().toast({ message: err.message, tone: 'error' }))
                }
              />
            </div>
          )}
        </section>

        <section className="card overflow-hidden">
          <h2 className="border-b border-slate-100 px-4 py-2 text-sm font-semibold text-slate-800">Per model, last 24 hours</h2>
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-2">Model</th>
                <th className="px-4 py-2">Answers</th>
                <th className="px-4 py-2">Failed</th>
                <th className="px-4 py-2">Stopped</th>
                <th className="px-4 py-2">TTFT p50 / p95</th>
                <th className="px-4 py-2">Duration p95</th>
                <th className="px-4 py-2">Output tokens</th>
              </tr>
            </thead>
            <tbody>
              {overview?.models.map((m) => (
                <tr key={m.model} className="border-t border-slate-100">
                  <td className="px-4 py-2 font-medium">{m.model}</td>
                  <td className="px-4 py-2 tabular-nums">{m.generations}</td>
                  <td className="px-4 py-2 tabular-nums">{m.failed}</td>
                  <td className="px-4 py-2 tabular-nums">{m.cancelled}</td>
                  <td className="px-4 py-2 tabular-nums">
                    {formatMs(m.ttftP50Ms)} / {formatMs(m.ttftP95Ms)}
                  </td>
                  <td className="px-4 py-2 tabular-nums">{formatMs(m.durationP95Ms)}</td>
                  <td className="px-4 py-2 tabular-nums">{m.outputTokens.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="card overflow-hidden">
          <h2 className="border-b border-slate-100 px-4 py-2 text-sm font-semibold text-slate-800">Recent generations</h2>
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-2">When</th>
                <th className="px-4 py-2">User</th>
                <th className="px-4 py-2">Conversation</th>
                <th className="px-4 py-2">Kind</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2">Tokens</th>
                <th className="px-4 py-2">TTFT</th>
              </tr>
            </thead>
            <tbody>
              {overview?.recent.map((r) => (
                <tr key={r.id} className="border-t border-slate-100">
                  <td className="px-4 py-2 text-slate-500">{timeAgo(r.createdAt)}</td>
                  <td className="px-4 py-2">{r.user}</td>
                  <td className="max-w-[220px] truncate px-4 py-2">{r.conversationTitle}</td>
                  <td className="px-4 py-2 text-slate-500">{r.kind}</td>
                  <td className="px-4 py-2">
                    <span className={`chip ${STATUS_STYLE[r.status] ?? ''}`} title={r.errorCode ?? undefined}>
                      {r.status}
                    </span>
                  </td>
                  <td className="px-4 py-2 tabular-nums">{r.outputTokens ?? '–'}</td>
                  <td className="px-4 py-2 tabular-nums">{formatMs(r.ttftMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>
    </div>
  )
}

function Knob({
  label,
  hint,
  value,
  step = 1,
  onCommit,
}: {
  label: string
  hint: string
  value: number | null
  step?: number
  onCommit: (value: number | null) => void
}) {
  const [draft, setDraft] = useState(value === null ? '' : String(value))
  useEffect(() => setDraft(value === null ? '' : String(value)), [value])
  const commit = () => {
    const next = draft.trim() === '' ? null : Number(draft)
    if (next !== null && !Number.isFinite(next)) return
    if (next !== value) onCommit(next)
  }
  const id = label.replace(/\W+/g, '-').toLowerCase()
  return (
    <div>
      <label htmlFor={id} className="label">
        {label}
      </label>
      <input
        id={id}
        type="number"
        step={step}
        className="input"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && commit()}
      />
      <p className="mt-1 text-xs text-slate-400">{hint}</p>
    </div>
  )
}
