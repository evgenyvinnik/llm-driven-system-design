/**
 * Fault injection (local demo only): make one consumer group fail matching
 * messages, to watch bounded retries fill the dead-letter stream, or crash after
 * commit to watch a redelivery turn into a no-op.
 */
import { useState } from 'react'
import type { Fault } from '@/types'

const GROUPS = ['workorder-sync', 'notifier', 'analyzer', 'ack-process', 'proj-alert-queue', 'proj-car-history', 'proj-detector-health', 'proj-reliability']

interface Props {
  faults: Record<string, Fault>
  onSet: (group: string, fault: Fault) => Promise<void>
  onClear: (group: string) => Promise<void>
}

export function FaultPanel({ faults, onSet, onClear }: Props) {
  const [group, setGroup] = useState('workorder-sync')
  const [match, setMatch] = useState('"yardId":"CDJ"')
  const [mode, setMode] = useState<Fault['mode']>('transient')
  const active = Object.entries(faults)
  return (
    <div className="space-y-3 text-sm">
      <div className="grid grid-cols-2 items-end gap-2">
        <label className="text-xs text-slate-600">Group<select className="input mt-0.5" value={group} onChange={(e) => setGroup(e.target.value)}>{GROUPS.map((g) => <option key={g}>{g}</option>)}</select></label>
        <label className="text-xs text-slate-600">Fail messages containing<input className="input mt-0.5 font-mono" value={match} onChange={(e) => setMatch(e.target.value)} /></label>
        <label className="text-xs text-slate-600">Mode
          <select className="input mt-0.5" value={mode} onChange={(e) => setMode(e.target.value as Fault['mode'])}>
            <option value="transient">transient (retry, then DLQ)</option>
            <option value="permanent">permanent (DLQ at once)</option>
            <option value="crash_after_commit">crash after commit, before ack</option>
          </select>
        </label>
        <button type="button" className="btn-secondary h-[34px]" onClick={() => void onSet(group, { match, mode })}>Set fault</button>
      </div>
      {active.length === 0 ? <p className="text-xs text-slate-500">No faults set.</p> : (
        <ul className="space-y-1">
          {active.map(([g, f]) => (
            <li key={g} className="flex items-center gap-2 rounded bg-amber-50 px-2 py-1 text-xs text-amber-900">
              <span className="font-mono font-semibold">{g}</span> fails <span className="font-mono">{f.match || 'every message'}</span> ({f.mode.replace(/_/g, ' ')})
              <button type="button" className="btn-ghost ml-auto text-xs" onClick={() => void onClear(g)}>Clear</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
