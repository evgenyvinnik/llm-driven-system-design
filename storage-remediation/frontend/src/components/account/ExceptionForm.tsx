import { useState, type FormEvent } from 'react'
import { ErrorNote } from '@/components/shared'
import { api } from '@/services/api'

const MAX: Record<string, number> = { critical: 30, high: 90, medium: 180, low: 365 }

export function ExceptionForm({ accountName, controlId, severity, onDone, onCancel }: { accountName: string; controlId: string; severity: string; onDone: () => void; onCancel: () => void }) {
  const [justification, setJustification] = useState('')
  const [days, setDays] = useState(Math.min(30, MAX[severity] ?? 30))
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await api.requestException({ accountName, controlId, justification, days })
      onDone()
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="card space-y-3 border-accent-200 p-4">
      <h3 className="text-sm font-semibold text-slate-800">Request an exception for {controlId}</h3>
      <p className="text-xs text-slate-500">An approver who is not you must accept the risk. Exceptions expire; when this one does, the finding reopens automatically. A {severity} finding can be excepted for at most {MAX[severity]} days.</p>
      <label className="block">
        <span className="label">Justification (who depends on this, and the migration plan)</span>
        <textarea className="input min-h-[80px]" value={justification} onChange={(e) => setJustification(e.target.value)} minLength={20} required />
      </label>
      <label className="block w-40">
        <span className="label">Duration (days)</span>
        <input className="input" type="number" min={1} max={MAX[severity]} value={days} onChange={(e) => setDays(Number(e.target.value))} />
      </label>
      <ErrorNote error={error} />
      <div className="flex gap-2">
        <button type="submit" className="btn-primary" disabled={busy}>{busy ? 'Submitting…' : 'Submit for approval'}</button>
        <button type="button" className="btn-ghost" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  )
}
