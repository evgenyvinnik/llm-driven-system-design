import { useState } from 'react'
import { api, ApiError } from '@/services/api'
import type { Alert } from '@/types'

const DISPATCHER_ACTIONS = [
  { value: 'stop_ordered', label: 'Stop ordered, crew inspecting' },
  { value: 'setout_planned', label: 'Set-out planned at next siding' },
  { value: 'restricted_speed', label: 'Restricted speed to inspection point' },
  { value: 'inspect_at_terminal', label: 'Inspect at next terminal' },
  { value: 'brake_inspection', label: 'Brake inspection arranged' },
  { value: 'monitor', label: 'Monitor only' },
]
const YARD_ACTIONS = [
  { value: 'will_inspect_on_arrival', label: 'Will inspect on arrival (car held)' },
  { value: 'brake_inspection', label: 'Brake inspection arranged' },
]

export function AckForm({ alert, onDone }: { alert: Alert; onDone: (message: string | null) => void }) {
  const actions = alert.ownerRole === 'yard' ? YARD_ACTIONS : DISPATCHER_ACTIONS
  const [action, setAction] = useState(alert.ownerRole === 'yard' ? 'will_inspect_on_arrival' : alert.tier >= 4 ? 'stop_ordered' : alert.tier === 3 ? 'setout_planned' : 'inspect_at_terminal')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    setBusy(true)
    setError(null)
    try {
      await api.acknowledge(alert.id, alert.version, action, note || undefined)
      onDone(null)
    } catch (err) {
      if (err instanceof ApiError && err.code === 'STALE_ALERT') {
        // It escalated (or someone else acknowledged it) since this screen loaded: show the new state first.
        onDone('This alert changed since you opened it. Review the update, then acknowledge again.')
      } else setError(err instanceof Error ? err.message : 'Acknowledge failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-2 rounded-md border border-slate-200 p-3">
      <div className="panel-title">Acknowledge</div>
      <select aria-label="Action taken" className="input" value={action} onChange={(e) => setAction(e.target.value)}>
        {actions.map((a) => (
          <option key={a.value} value={a.value}>{a.label}</option>
        ))}
      </select>
      <input className="input" placeholder="Note (siding, crew report…)" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
      {error && <p className="text-sm text-red-600">{error}</p>}
      <button type="button" className="btn-primary w-full" disabled={busy} onClick={() => void submit()}>
        {busy ? 'Saving…' : `Acknowledge ${alert.tierName}`}
      </button>
    </div>
  )
}
