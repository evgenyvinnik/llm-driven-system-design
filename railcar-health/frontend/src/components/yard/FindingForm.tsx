/**
 * Inspection finding entry for a yard tablet. The clientSubmissionId is made
 * once, when the form opens, so a double tap, a retry or an offline resend all
 * carry the same id and the server records one finding.
 */
import { useState } from 'react'
import { ApiError, type FindingInput } from '@/services/api'
import { submitOrQueue } from '@/services/offline-queue'
import type { WorkOrder } from '@/types'

const FINDINGS: Array<{ value: FindingInput['finding']; label: string }> = [
  { value: 'confirmed_bearing_defect', label: 'Confirmed bearing defect' },
  { value: 'wheel_defect', label: 'Wheel / brake defect' },
  { value: 'no_defect_found', label: 'No defect found' },
]

export function FindingForm({ workOrder, onDone }: { workOrder: WorkOrder; onDone: (result: 'sent' | 'queued') => void }) {
  const [submissionId] = useState(() => crypto.randomUUID())
  const [finding, setFinding] = useState<FindingInput['finding']>(workOrder.kind === 'hot_wheel' ? 'wheel_defect' : 'confirmed_bearing_defect')
  const [disposition, setDisposition] = useState<FindingInput['disposition']>('bad_order')
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const defect = finding !== 'no_defect_found'

  async function submit() {
    setBusy(true)
    setError(null)
    try {
      const result = await submitOrQueue({
        workOrderId: workOrder.id,
        carId: workOrder.carId,
        input: { clientSubmissionId: submissionId, finding, disposition: defect ? 'bad_order' : disposition, notes: notes || undefined, observedAt: new Date().toISOString() },
        queuedAt: new Date().toISOString(),
      })
      onDone(result)
    } catch (err) {
      setError(err instanceof ApiError ? `${err.message}${err.code === 'ALREADY_COMPLETED' ? ' (someone else recorded it)' : ''}` : 'Submit failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-3 space-y-3 rounded-md border border-slate-200 bg-slate-50 p-3">
      <fieldset>
        <legend className="label">Finding</legend>
        <div className="flex flex-wrap gap-2">
          {FINDINGS.map((f) => (
            <label key={f.value} className={`flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm ${finding === f.value ? 'border-slate-900 bg-white font-medium' : 'border-slate-200 bg-white'}`}>
              <input type="radio" name={`finding-${workOrder.id}`} value={f.value} checked={finding === f.value} onChange={() => setFinding(f.value)} />
              {f.label}
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset>
        <legend className="label">Disposition</legend>
        <div className="flex gap-2">
          <label className="flex items-center gap-2 text-sm"><input type="radio" name={`disp-${workOrder.id}`} checked={defect || disposition === 'bad_order'} onChange={() => setDisposition('bad_order')} /> Bad-order to repair track</label>
          <label className={`flex items-center gap-2 text-sm ${defect ? 'opacity-40' : ''}`}><input type="radio" name={`disp-${workOrder.id}`} disabled={defect} checked={!defect && disposition === 'release'} onChange={() => setDisposition('release')} /> Release to service</label>
        </div>
        {defect && <p className="mt-1 text-xs text-slate-500">A car with a confirmed defect can't be released.</p>}
      </fieldset>
      <textarea className="input" rows={2} placeholder="Notes (bearing cap, seal, grease, wheel tread…)" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={1000} />
      {error && <p className="text-sm text-red-600">{error}</p>}
      <div className="flex items-center justify-between">
        <span className="font-mono text-[11px] text-slate-400">submission {submissionId.slice(0, 8)}</span>
        <button type="button" className="btn-primary" disabled={busy} onClick={() => void submit()}>{busy ? 'Saving…' : 'Record finding'}</button>
      </div>
    </div>
  )
}
