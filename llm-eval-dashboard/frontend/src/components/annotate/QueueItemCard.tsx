import { useState } from 'react'
import { CheckIcon, XIcon } from '@/components/icons'
import { PassChip } from '@/components/shared/Chips'
import { api } from '@/services/api'
import type { QueueItem } from '@/types'

const REASON: Record<string, string> = { low_confidence: 'judge unsure', samples_disagree: 'samples disagree', spot_check: 'random spot check' }

export function QueueItemCard({ runId, item, onSaved }: { runId: string; item: QueueItem; onSaved: () => void }) {
  const [note, setNote] = useState(item.annotation?.note ?? '')
  const [busy, setBusy] = useState(false)
  async function label(l: 'pass' | 'fail') {
    setBusy(true)
    try {
      await api.annotate(runId, item.caseResultId, l, note)
      onSaved()
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className={`card space-y-2 p-3 ${item.annotation ? 'opacity-80' : ''}`}>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="font-mono font-semibold">
          {item.caseKey} · sample {item.sampleIndex}
        </span>
        {item.reasons.map((r) => (
          <span key={r} className="chip bg-violet-100 text-violet-800">
            {REASON[r]}
          </span>
        ))}
        {item.annotation && (
          <span className="ml-auto text-slate-500">
            labeled <b>{item.annotation.label}</b> by {item.annotation.by}
          </span>
        )}
      </div>
      <div className="grid grid-cols-2 gap-2 text-[11px]">
        <div>
          <div className="label">Output</div>
          <pre className="max-h-32 overflow-auto whitespace-pre-wrap rounded bg-slate-50 p-2 font-mono text-slate-800">{item.output}</pre>
        </div>
        <div>
          <div className="label">Reference</div>
          <pre className="whitespace-pre-wrap rounded bg-slate-50 p-2 font-mono text-slate-800">{item.reference}</pre>
          {item.judge.map((j) => (
            <div key={j.scorerVersionId} className="mt-1 flex flex-wrap items-center gap-1 text-slate-600">
              {j.name} v{j.version}: <PassChip passed={j.passed} /> conf {j.confidence === null ? '—' : j.confidence.toFixed(2)}
              <span className="w-full text-slate-500">{j.rationale}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="flex items-center gap-2">
        <input className="input" placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} aria-label="Note" />
        <button type="button" className="btn-secondary text-emerald-700" disabled={busy} onClick={() => void label('pass')}>
          <CheckIcon /> Pass
        </button>
        <button type="button" className="btn-danger" disabled={busy} onClick={() => void label('fail')}>
          <XIcon /> Fail
        </button>
      </div>
    </div>
  )
}
