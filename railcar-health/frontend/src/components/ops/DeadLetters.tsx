/** The dead-letter stream: what failed, why, how many attempts, the raw event, and redrive. */
import { useState } from 'react'
import { PayloadView } from '@/components/events/PayloadView'
import { Empty } from '@/components/shared/Loading'
import { clockText, familyStyle } from '@/lib/events'
import type { DeadLetter } from '@/types'

interface Props {
  entries: DeadLetter[]
  onRedrive: (id: string) => Promise<void>
  onRedriveAll: () => Promise<void>
}

export function DeadLetters({ entries, onRedrive, onRedriveAll }: Props) {
  const [open, setOpen] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    try {
      await fn()
    } finally {
      setBusy(false)
    }
  }
  if (entries.length === 0) return <Empty>The dead-letter stream is empty. Use a fault below to watch a message retry and land here.</Empty>
  return (
    <div>
      <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2 text-xs text-slate-500">
        <span>Redrive re-publishes the event to its original stream for that group only; other groups skip it, and processed-events makes a repeat harmless.</span>
        <button type="button" className="btn-secondary" disabled={busy} onClick={() => void run(onRedriveAll)}>Redrive all</button>
      </div>
      <ul className="divide-y divide-slate-100" aria-label="Dead letters">
        {entries.map((d) => (
          <li key={d.id} className="px-4 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-sm font-semibold">{d.group}</span>
              <span className={`chip ring-1 ${familyStyle(d.streamKey.replace('rh:ev:', ''))}`}>{d.type || 'unparseable'}</span>
              <span className={`chip ${d.permanent ? 'bg-red-100 text-red-800' : 'bg-amber-100 text-amber-900'}`}>{d.permanent ? 'permanent' : `transient · ${d.attempts} attempts`}</span>
              <span className="font-mono text-[11px] text-slate-400">{d.streamKey} {d.messageId}</span>
              <span className="text-xs text-slate-500">dead at {clockText(d.deadAt)}</span>
              <div className="ml-auto flex gap-2">
                <button type="button" className="btn-ghost text-xs" onClick={() => setOpen(open === d.id ? null : d.id)}>{open === d.id ? 'Hide payload' : 'Payload'}</button>
                <button type="button" className="btn-primary text-xs" disabled={busy} onClick={() => void run(() => onRedrive(d.id))}>Redrive</button>
              </div>
            </div>
            <p className="mt-1 rounded bg-red-50 px-2 py-1 font-mono text-xs text-red-800">{d.error}</p>
            {d.event.upcast && <p className="mt-1 text-xs text-slate-600">{d.event.upcast.summary}</p>}
            {open === d.id && <div className="mt-2"><PayloadView label="Event as it was on the broker" value={d.event.raw} /></div>}
          </li>
        ))}
      </ul>
    </div>
  )
}
