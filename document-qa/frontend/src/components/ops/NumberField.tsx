/** A labelled numeric knob with its live value and a Set button. */
import { useState } from 'react'

export function NumberField({ label, hint, value, step = 1, onSave }: { label: string; hint?: string; value: number | null; step?: number; onSave: (v: number) => Promise<void> }) {
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  async function save() {
    const v = Number(draft)
    if (draft === '' || !Number.isFinite(v)) return
    setBusy(true)
    try {
      await onSave(v)
      setDraft('')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="flex items-center gap-2 py-1">
      <div className="min-w-0 flex-1">
        <div className="text-sm text-slate-700">{label}</div>
        {hint && <div className="text-[11px] text-slate-400">{hint}</div>}
      </div>
      <span className="num w-14 text-right text-sm font-semibold text-slate-900" aria-label={`${label} current value`}>
        {value ?? '—'}
      </span>
      <input
        className="input !w-20 !py-1"
        type="number"
        step={step}
        min={0}
        value={draft}
        placeholder="new"
        aria-label={`${label} new value`}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void save()
        }}
      />
      <button type="button" className="btn-secondary !px-2 !py-1 text-xs" disabled={busy || draft === ''} onClick={() => void save()}>
        Set
      </button>
    </div>
  )
}
