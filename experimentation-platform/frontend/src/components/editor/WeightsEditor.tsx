/**
 * Variant weights with a live preview. The proposed ranges are computed in the
 * browser with the shared allocator (the server recomputes the same thing on
 * save), so the bars and the "moves N%" line are exact before anything is saved.
 */
import { useEffect, useMemo, useState } from 'react'
import { allocateStable, BUCKETS, type Allocation } from '@exp/core'
import { VariantLegend, WeightsBar } from '@/components/shared/WeightsBar'
import { pctBuckets } from '@/lib/format'
import { api, ApiError } from '@/services/api'
import type { Flag } from '@/types'
import { MovePreview } from './MovePreview'

const toPct = (buckets: number) => String(buckets / 100)

export function WeightsEditor({ flag, env, canEdit, onSaved }: { flag: Flag; env: string; canEdit: boolean; onSaved: () => void }) {
  const cfg = flag.configs[env]
  // A flag has one weight (the "on" share); "off" is everyone else. An experiment weighs every variant.
  const editable = flag.kind === 'flag' ? flag.variants.filter((v) => v.key !== flag.defaultVariant) : flag.variants
  const order = editable.map((v) => v.key)
  const initial = useMemo(() => Object.fromEntries(order.map((k) => [k, toPct(cfg.weights[k] ?? 0)])), [cfg.version, env]) // eslint-disable-line react-hooks/exhaustive-deps
  const [draft, setDraft] = useState<Record<string, string>>(initial)
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => setDraft(initial), [initial])

  const before = Object.fromEntries(order.map((k) => [k, cfg.weights[k] ?? 0]))
  const after = Object.fromEntries(order.map((k) => [k, Math.round(Number(draft[k] || 0) * 100)]))
  const total = Object.values(after).reduce((a, b) => a + b, 0)
  const invalid = Object.values(after).some((w) => !Number.isFinite(w) || w < 0) ? 'Weights must be numbers ≥ 0' : total > BUCKETS ? `Weights add up to ${total / 100}%` : null
  const changed = order.some((k) => before[k] !== after[k])
  let proposed: Allocation | null = null
  if (!invalid) {
    try {
      proposed = allocateStable(cfg.allocation, after)
    } catch {
      proposed = null
    }
  }

  async function save() {
    setBusy(true)
    setMessage(null)
    try {
      const res = await api.updateConfig(flag.key, env, cfg.version, { weights: after })
      setMessage({ tone: 'ok', text: `Saved as v${res.flag.configs[env].version}; snapshot v${res.snapshotVersion} pushed. ${pctBuckets(res.move.changed)} of units moved.` })
      onSaved()
    } catch (err) {
      setMessage({ tone: 'error', text: err instanceof ApiError ? err.message : 'Save failed' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="card space-y-4 p-4" aria-label="Variants and weights">
      <div className="flex items-baseline justify-between">
        <h2 className="panel-title">{flag.kind === 'flag' ? 'Rollout' : 'Variants & weights'}</h2>
        <span className="text-xs text-slate-500">{pctBuckets(BUCKETS - total)} not enrolled (served the default, never logged as exposed)</span>
      </div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3">
        {editable.map((v) => (
          <label key={v.key} className="block">
            <span className="label">
              {v.key} {v.key === flag.defaultVariant && flag.kind === 'experiment' && <span className="normal-case text-slate-400">(control)</span>}
            </span>
            <div className="flex items-center gap-1">
              <input className="input num" inputMode="decimal" name={`weight-${v.key}`} value={draft[v.key] ?? ''} disabled={!canEdit || cfg.status === 'stopped'} onChange={(e) => setDraft((d) => ({ ...d, [v.key]: e.target.value }))} />
              <span className="text-sm text-slate-500">%</span>
            </div>
            <span className="mt-0.5 block truncate text-[11px] text-slate-400">{v.name}</span>
          </label>
        ))}
      </div>
      <div className="space-y-1.5">
        <div className="flex items-center gap-2 text-[11px] text-slate-500">
          <span className="w-16">current</span>
          <WeightsBar allocation={cfg.allocation} variants={order} label="Current bucket ranges" />
        </div>
        {proposed && changed && (
          <div className="flex items-center gap-2 text-[11px] text-slate-500">
            <span className="w-16">proposed</span>
            <WeightsBar allocation={proposed} variants={order} label="Proposed bucket ranges" />
          </div>
        )}
        <VariantLegend variants={editable} weights={before} />
      </div>
      {invalid && <p className="text-xs font-medium text-rose-700">{invalid}</p>}
      {proposed && changed && <MovePreview current={cfg.allocation} proposed={proposed} before={before} after={after} order={order} control={flag.kind === 'flag' ? '__none__' : flag.defaultVariant} />}
      <div className="flex items-center gap-2">
        <button type="button" className="btn-primary" disabled={!canEdit || !changed || !!invalid || busy} onClick={() => void save()}>
          Save weights
        </button>
        {changed && (
          <button type="button" className="btn-ghost" onClick={() => setDraft(initial)}>
            Reset
          </button>
        )}
        {message && <span className={`text-xs ${message.tone === 'ok' ? 'text-emerald-700' : 'font-medium text-rose-700'}`}>{message.text}</span>}
      </div>
    </section>
  )
}
