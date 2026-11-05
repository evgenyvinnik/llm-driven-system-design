import { CheckIcon, ClockIcon, PauseIcon } from '@/components/icons'
import { num } from '@/lib/format'
import type { Wave } from '@/types'

const SEGMENTS: { key: 'verified' | 'baking' | 'applying' | 'queued' | 'rolled_back' | 'failed' | 'escalated' | 'skipped'; label: string; color: string }[] = [
  { key: 'verified', label: 'verified', color: 'bg-status-good' },
  { key: 'baking', label: 'baking', color: 'bg-accent-500' },
  { key: 'applying', label: 'applying', color: 'bg-accent-300' },
  { key: 'queued', label: 'queued', color: 'bg-slate-300' },
  { key: 'rolled_back', label: 'rolled back', color: 'bg-status-serious' },
  { key: 'failed', label: 'failed', color: 'bg-status-critical' },
  { key: 'escalated', label: 'escalated', color: 'bg-status-warning' },
  { key: 'skipped', label: 'skipped', color: 'bg-slate-200' },
]

function StatusIcon({ status }: { status: Wave['status'] }) {
  if (status === 'completed') return <CheckIcon className="h-4 w-4 text-status-good" />
  if (status === 'halted') return <PauseIcon className="h-4 w-4 text-status-warning" />
  if (status === 'running') return <ClockIcon className="h-4 w-4 text-accent-600" />
  return <span className="block h-4 w-4 rounded-full border-2 border-slate-200" aria-hidden />
}

export function WaveProgress({ waves }: { waves: Wave[] }) {
  return (
    <div className="card p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-slate-800">Waves</h2>
        <div className="flex flex-wrap gap-3 text-[11px] text-slate-600">
          {SEGMENTS.map((s) => (
            <span key={s.key} className="inline-flex items-center gap-1"><span className={`h-2 w-2 rounded-[2px] ${s.color}`} aria-hidden /> {s.label}</span>
          ))}
        </div>
      </div>
      <ol className="space-y-2.5">
        {waves.map((w) => (
          <li key={w.waveNo} className="grid grid-cols-[1.25rem_11rem_1fr_9rem] items-center gap-3">
            <StatusIcon status={w.status} />
            <div>
              <div className="text-sm font-medium text-slate-800">W{w.waveNo} · {w.label}</div>
              <div className="text-xs text-slate-500">{w.status}{w.acknowledgedFailures > 0 ? ` · ${w.acknowledgedFailures} acknowledged` : ''}</div>
            </div>
            <div className="flex h-2.5 gap-[2px]" role="img" aria-label={SEGMENTS.map((s) => `${s.label} ${w.counts[s.key]}`).join(', ')}>
              {w.counts.total === 0 && <div className="h-full w-full rounded-[3px] bg-slate-100" />}
              {SEGMENTS.filter((s) => w.counts[s.key] > 0).map((s) => (
                <div key={s.key} className={`h-full rounded-[3px] ${s.color}`} style={{ width: `${(w.counts[s.key] / Math.max(1, w.counts.total)) * 100}%` }} title={`${s.label}: ${w.counts[s.key]}`} />
              ))}
              {w.counts.pending > 0 && <div className="h-full rounded-[3px] bg-slate-100" style={{ width: `${(w.counts.pending / Math.max(1, w.counts.total)) * 100}%` }} title={`pending: ${w.counts.pending}`} />}
            </div>
            <div className="text-right text-xs text-slate-600">
              {num(w.counts.verified)}/{num(w.targetCount)} verified
              {w.counts.rolled_back + w.counts.failed > 0 && <div className="text-orange-800">{w.counts.rolled_back} rolled back · {w.counts.failed} failed</div>}
            </div>
          </li>
        ))}
      </ol>
    </div>
  )
}
