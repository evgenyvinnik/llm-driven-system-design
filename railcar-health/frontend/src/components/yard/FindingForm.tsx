/**
 * Inspection finding entry for a yard tablet. The clientSubmissionId is made
 * once, when the form opens, so a double tap, a retry or an offline resend all
 * carry the same id and the server records one finding.
 */
import { useState } from 'react'
import { ApiError, type FindingInput } from '@/services/api'
import { submitOrQueue } from '@/services/offline-queue'
import type { WorkOrder } from '@/types'

// Bearing and brake defects are different failure modes, recorded separately.
const FINDINGS: Array<{ value: FindingInput['finding']; label: string }> = [
  { value: 'confirmed_bearing_defect', label: 'Journal bearing defect' },
  { value: 'brake_defect', label: 'Brake defect (stuck / inoperative)' },
  { value: 'wheel_defect', label: 'Wheel tread defect' },
  { value: 'no_defect_found', label: 'No defect found' },
]

const localNow = () => {
  const d = new Date()
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset())
  return d.toISOString().slice(0, 16)
}

export function FindingForm({ workOrder, onDone }: { workOrder: WorkOrder; onDone: (result: 'sent' | 'queued') => void }) {
  const [submissionId] = useState(() => crypto.randomUUID())
  const brake = workOrder.kind === 'hot_wheel' || workOrder.kind === 'cold_wheel'
  const [finding, setFinding] = useState<FindingInput['finding']>(workOrder.kind === 'audit' ? 'no_defect_found' : brake ? 'brake_defect' : 'confirmed_bearing_defect')
  const [disposition, setDisposition] = useState<FindingInput['disposition']>(workOrder.kind === 'audit' ? 'release' : 'bad_order')
  const [componentId, setComponentId] = useState('')
  const [installedAt, setInstalledAt] = useState(localNow)
  const [axle, setAxle] = useState(/^[LR]\d$/.test(workOrder.position) ? Number(workOrder.position.slice(1)) : 1)
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
        input: {
          clientSubmissionId: submissionId,
          finding,
          disposition: defect && disposition === 'release' ? 'bad_order' : disposition,
          notes: notes || undefined,
          observedAt: new Date().toISOString(),
          // A repair records the new wheelset with its install time: readings before it never count against it.
          ...(disposition === 'repaired' ? { replacement: { componentId, installedAt: new Date(installedAt).toISOString(), axle } } : {}),
        },
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
        <div className="flex flex-wrap gap-3">
          <label className="flex items-center gap-2 text-sm"><input type="radio" name={`disp-${workOrder.id}`} checked={disposition === 'bad_order' || (defect && disposition === 'release')} onChange={() => setDisposition('bad_order')} /> Bad-order to repair track</label>
          <label className="flex items-center gap-2 text-sm"><input type="radio" name={`disp-${workOrder.id}`} checked={disposition === 'repaired'} onChange={() => setDisposition('repaired')} /> Wheelset replaced, release</label>
          <label className={`flex items-center gap-2 text-sm ${defect ? 'opacity-40' : ''}`}><input type="radio" name={`disp-${workOrder.id}`} disabled={defect} checked={!defect && disposition === 'release'} onChange={() => setDisposition('release')} /> Release to service</label>
        </div>
        {defect && <p className="mt-1 text-xs text-slate-500">A car with a confirmed defect can't be released as is.</p>}
      </fieldset>
      {disposition === 'repaired' && (
        <div className="grid grid-cols-3 gap-2">
          <label className="text-xs text-slate-600">New wheelset serial<input className="input mt-0.5" name="componentId" value={componentId} onChange={(e) => setComponentId(e.target.value)} placeholder="WS-2026-…" /></label>
          <label className="text-xs text-slate-600">Installed at<input type="datetime-local" className="input mt-0.5" value={installedAt} onChange={(e) => setInstalledAt(e.target.value)} /></label>
          <label className="text-xs text-slate-600">Axle (1 = B-end)<input type="number" min={1} max={4} className="input mt-0.5" value={axle} onChange={(e) => setAxle(Number(e.target.value))} /></label>
        </div>
      )}
      <textarea className="input" rows={2} placeholder="Notes (bearing cap, seal, grease, wheel tread…)" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={1000} />
      {error && <p className="text-sm text-red-600">{error}</p>}
      <div className="flex items-center justify-between">
        <span className="font-mono text-[11px] text-slate-400">submission {submissionId.slice(0, 8)}</span>
        <button type="button" className="btn-primary" disabled={busy || (disposition === 'repaired' && componentId.length < 3)} onClick={() => void submit()}>{busy ? 'Saving…' : 'Record finding'}</button>
      </div>
    </div>
  )
}
