import { useState, type ReactNode } from 'react'
import { OVERRIDE_REASONS } from '@/lib/format'

export interface ReasonValue {
  reason: string
  reasonCode: string
}

/** Every human decision against the plan records who, why, and what changed. This asks for the why. */
export function ReasonDialog({ title, children, confirmLabel = 'Apply', busy, onCancel, onConfirm }: { title: string; children?: ReactNode; confirmLabel?: string; busy?: boolean; onCancel: () => void; onConfirm: (v: ReasonValue) => void }) {
  const [reason, setReason] = useState('')
  const [reasonCode, setReasonCode] = useState('crew_availability')
  const valid = reason.trim().length >= 3
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/40 p-4" role="dialog" aria-modal="true" aria-label={title}>
      <form
        className="card w-full max-w-lg space-y-3 p-4 shadow-lg"
        onSubmit={(e) => {
          e.preventDefault()
          if (valid) onConfirm({ reason: reason.trim(), reasonCode })
        }}
      >
        <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
        {children}
        <div>
          <label className="label" htmlFor="reason-code">Reason</label>
          <select id="reason-code" className="input" value={reasonCode} onChange={(e) => setReasonCode(e.target.value)}>
            {OVERRIDE_REASONS.map((r) => (
              <option key={r.code} value={r.code}>{r.label}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="reason-text">In your words</label>
          <input id="reason-text" name="reason" className="input" autoFocus value={reason} onChange={(e) => setReason(e.target.value)} placeholder="What should the next person know?" />
        </div>
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onCancel}>Cancel</button>
          <button type="submit" className="btn-primary" disabled={!valid || busy}>{confirmLabel}</button>
        </div>
      </form>
    </div>
  )
}
