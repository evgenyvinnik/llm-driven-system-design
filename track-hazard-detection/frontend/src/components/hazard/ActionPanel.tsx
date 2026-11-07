import { useState } from 'react'
import { CheckIcon, SignIcon, TrainIcon, UserIcon, XIcon } from '@/components/icons'
import { useCommand } from '@/lib/useCommand'
import type { CommandResult } from '@/services/api'
import { useAuthStore } from '@/stores/auth-store'
import type { HazardDetail } from '@/types'

/** Dispatcher / inspector commands. The server re-checks every rule; the UI just hides what can't apply. */
export function ActionPanel({ detail, onDone }: { detail: HazardDetail; onDone: (r: CommandResult) => void }) {
  const h = detail.hazard
  const user = useAuthStore((s) => s.user)
  const { run, busy, error, notice } = useCommand(h.hazardId, h.version, onDone)
  const [speed, setSpeed] = useState(h.kind === 'rail_buckling_risk' ? 40 : 10)
  const [from, setFrom] = useState(Math.round((h.mpFrom - 0.5) * 10) / 10)
  const [to, setTo] = useState(Math.round((h.mpTo + 0.5) * 10) / 10)
  const [inspector, setInspector] = useState(detail.inspectors[0]?.username ?? '')
  const [note, setNote] = useState('')
  if (!h.open) return <p className="text-sm text-slate-500">This hazard is closed. Its stream stays as the audit record.</p>
  const isInspector = user?.role === 'inspector'
  const canAck = !isInspector && h.alert && !h.alert.acknowledgedAt
  return (
    <div className="space-y-3 text-sm">
      {!isInspector && (
        <div className="flex flex-wrap gap-2">
          {canAck && (
            <button type="button" className="btn-primary" disabled={!!busy} onClick={() => void run({ kind: 'acknowledge' })}>
              <CheckIcon /> Acknowledge
            </button>
          )}
          <button type="button" className="btn-secondary" disabled={!!busy} onClick={() => void run({ kind: 'warn_trains' })}>
            <TrainIcon /> Warn approaching trains
          </button>
        </div>
      )}
      {!isInspector && (
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Slow order mph">
            <input className="input w-20" type="number" min={0} max={60} value={speed} onChange={(e) => setSpeed(Number(e.target.value))} />
          </Field>
          <Field label="From MP">
            <input className="input w-24" type="number" step={0.1} value={from} onChange={(e) => setFrom(Number(e.target.value))} />
          </Field>
          <Field label="To MP">
            <input className="input w-24" type="number" step={0.1} value={to} onChange={(e) => setTo(Number(e.target.value))} />
          </Field>
          <button type="button" className="btn-secondary" disabled={!!busy} onClick={() => void run({ kind: 'speed_restriction', mpFrom: from, mpTo: to, maxSpeedMph: speed })}>
            <SignIcon /> Issue
          </button>
        </div>
      )}
      {!isInspector && (
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Inspector">
            <select className="input w-48" value={inspector} onChange={(e) => setInspector(e.target.value)}>
              {detail.inspectors.map((i) => (
                <option key={i.username} value={i.username}>
                  {i.displayName}
                </option>
              ))}
            </select>
          </Field>
          <button type="button" className="btn-secondary" disabled={!!busy || !inspector} onClick={() => void run({ kind: 'dispatch_inspector', inspector, etaMinutes: 30 })}>
            <UserIcon /> Dispatch
          </button>
        </div>
      )}
      <div className="flex flex-wrap items-end gap-2 border-t border-slate-100 pt-3">
        <Field label="Note">
          <input className="input w-72" value={note} onChange={(e) => setNote(e.target.value)} placeholder="What the inspection found" />
        </Field>
        <button type="button" className="btn-secondary" disabled={!!busy} onClick={() => void run({ kind: 'clear', note: note || undefined })}>
          <CheckIcon /> Hazard cleared
        </button>
        <button type="button" className="btn-ghost" disabled={!!busy} onClick={() => void run({ kind: 'false_alarm', note: note || undefined })}>
          <XIcon /> False alarm
        </button>
      </div>
      {error && <p className="rounded-md bg-red-50 px-3 py-2 text-red-700">{error}</p>}
      {notice && <p className="rounded-md bg-emerald-50 px-3 py-2 text-emerald-800">{notice}</p>}
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="label">{label}</span>
      {children}
    </label>
  )
}
