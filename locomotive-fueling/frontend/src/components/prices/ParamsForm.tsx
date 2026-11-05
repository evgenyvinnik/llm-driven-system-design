import { useState } from 'react'
import { api } from '@/services/api'
import type { Params } from '@/types'

const FIELDS: { key: string; label: string; hint: string; pct?: boolean }[] = [
  { key: 'reservePct', label: 'Reserve (share of tank)', hint: 'Hard floor every unit keeps at every station', pct: true },
  { key: 'reserveMinGal', label: 'Reserve floor (gal)', hint: 'Never below this, whatever the tank size' },
  { key: 'safetyMarginPct', label: 'Burn margin', hint: 'Forecast inflated by this for the reserve check', pct: true },
  { key: 'delayCostPerHour', label: 'Train-hour cost ($)', hint: 'Dwell and queue time priced into the objective' },
  { key: 'stopPenalty', label: 'Stop penalty ($)', hint: 'Fixed cost of stopping at all' },
  { key: 'hysteresisAbs', label: 'Switch threshold ($)', hint: 'Minimum saving to replace a recommended plan' },
  { key: 'acceptedChangeCost', label: 'Accepted change cost ($)', hint: 'Extra bar once a plan is accepted' },
  { key: 'terminalDiscountPerGal', label: 'Terminal credit discount ($/gal)', hint: 'Leftover fuel worth less than the posted price' },
  { key: 'orderWindowHours', label: 'DTL order window (h)', hint: 'Order trucks for accepted stops this close' },
  { key: 'optimizerBudgetMs', label: 'Optimizer budget (ms)', hint: 'Past it: greedy, then last good plan' },
]

export function ParamsForm({ params, editable, onSaved }: { params: Params; editable: boolean; onSaved: () => void }) {
  const [draft, setDraft] = useState<Record<string, string>>(Object.fromEntries(FIELDS.map((f) => [f.key, String(params[f.key])])))
  const [status, setStatus] = useState<string | null>(null)
  const save = async () => {
    const patch: Params = {}
    for (const f of FIELDS) if (Number(draft[f.key]) !== params[f.key]) patch[f.key] = Number(draft[f.key])
    if (Object.keys(patch).length === 0) return
    try {
      await api.updateParams(patch)
      setStatus('Saved; every running train is being re-planned')
      onSaved()
    } catch (e) {
      setStatus((e as Error).message)
    }
  }
  return (
    <div className="card p-4">
      <div className="panel-title mb-3">Planner and safety parameters</div>
      <div className="grid gap-3 sm:grid-cols-2">
        {FIELDS.map((f) => (
          <label key={f.key} className="text-sm">
            <span className="label">{f.label}</span>
            <input className="input num" value={draft[f.key]} disabled={!editable} onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })} />
            <span className="text-[11px] text-slate-500">{f.hint}{f.pct ? ' (0.10 = 10%)' : ''}</span>
          </label>
        ))}
      </div>
      {editable && (
        <div className="mt-3 flex items-center gap-3">
          <button type="button" className="btn-primary" onClick={() => void save()}>
            Save parameters
          </button>
          {status && <span className="text-xs text-slate-600">{status}</span>}
        </div>
      )}
    </div>
  )
}
