import { useState } from 'react'
import { api } from '@/services/api'
import type { ReceiverMode, ReceiverPath } from '@/types'

const MODES: { mode: ReceiverMode; label: string; hint: string }[] = [
  { mode: 'ok', label: 'Healthy', hint: 'verify, dedupe, 200' },
  { mode: 'error500', label: '500', hint: 'server error before processing' },
  { mode: 'slow', label: 'Slow', hint: 'process, answer after a delay' },
  { mode: 'drop_ack', label: 'Drop ack', hint: 'process, then close the socket' },
  { mode: 'rate429', label: '429', hint: 'rate limited with Retry-After' },
  { mode: 'gone410', label: '410', hint: 'gone: stop sending' },
]

/** Fault toggles for one receiver path. "Next N" arms the fault for N requests; otherwise it stays on. */
export function PathControls({ path, onChange }: { path: ReceiverPath; onChange: () => void }) {
  const [count, setCount] = useState(3)
  const [armed, setArmed] = useState(true)
  const c = path.config

  async function set(mode: ReceiverMode) {
    await api.setReceiverPath(path.name, mode === 'ok' ? { mode } : { mode, remaining: armed ? count : null })
    onChange()
  }
  async function patch(body: { slowMs?: number; retryAfterSeconds?: number }) {
    await api.setReceiverPath(path.name, body)
    onChange()
  }

  return (
    <div className="card space-y-2 p-3">
      <div className="flex items-baseline justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate font-mono text-sm font-semibold text-slate-900">/hooks/{path.name}</div>
          <div className="truncate text-xs text-slate-500">{path.description}{path.status === 'disabled' ? ' · endpoint disabled' : ''}</div>
        </div>
        <span className={`chip shrink-0 ${c.mode === 'ok' ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-800'}`}>
          {MODES.find((m) => m.mode === c.mode)?.label}
          {c.mode !== 'ok' && (c.remaining === null ? ' · until changed' : ` · next ${c.remaining}`)}
        </span>
      </div>
      <div className="flex flex-wrap gap-1">
        {MODES.map((m) => (
          <button key={m.mode} type="button" title={m.hint} aria-pressed={c.mode === m.mode}
            className={`rounded-md border px-2 py-1 text-xs font-medium ${c.mode === m.mode ? 'border-slate-900 bg-slate-900 text-white' : 'border-slate-200 text-slate-700 hover:bg-slate-50'}`}
            onClick={() => void set(m.mode)}>
            {m.label}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-3 text-xs text-slate-600">
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={armed} onChange={(e) => setArmed(e.target.checked)} /> next
          <input type="number" min={1} max={100} className="input w-14 px-1.5 py-0.5 text-xs" value={count} onChange={(e) => setCount(Number(e.target.value))} aria-label="Requests" /> requests
        </label>
        <label className="flex items-center gap-1">slow
          <input type="number" min={0} step={500} className="input w-20 px-1.5 py-0.5 text-xs" defaultValue={c.slowMs} onBlur={(e) => void patch({ slowMs: Number(e.target.value) })} aria-label="Slow milliseconds" /> ms
        </label>
        <label className="flex items-center gap-1">Retry-After
          <input type="number" min={0} className="input w-14 px-1.5 py-0.5 text-xs" defaultValue={c.retryAfterSeconds} onBlur={(e) => void patch({ retryAfterSeconds: Number(e.target.value) })} aria-label="Retry-After seconds" /> s
        </label>
        {c.pinnedSecrets !== null && <span className="text-amber-700">pinned to {c.pinnedSecrets} secret(s)</span>}
      </div>
    </div>
  )
}
