/** Consumer groups: per broker stream, lag (not yet delivered), pending (delivered, not acked), checkpoint and staleness. */
import type { ConsumerGroupStats } from '@/types'

const KIND: Record<ConsumerGroupStats['kind'], string> = {
  analyzer: 'bg-slate-800 text-white',
  integration: 'bg-sky-50 text-sky-800 ring-1 ring-sky-200',
  process: 'bg-fuchsia-50 text-fuchsia-800 ring-1 ring-fuchsia-200',
  projection: 'bg-emerald-50 text-emerald-800 ring-1 ring-emerald-200',
}

const staleText = (s: number) => (s <= 0 ? 'caught up' : s < 60 ? `${s.toFixed(1)} s` : `${Math.round(s / 60)} min`)

export function GroupTable({ groups }: { groups: ConsumerGroupStats[] }) {
  return (
    <table className="w-full" aria-label="Consumer groups">
      <thead className="border-b border-slate-100 bg-slate-50">
        <tr><th className="th">Group</th><th className="th">Stream (topic)</th><th className="th text-right">Lag</th><th className="th text-right">Pending</th><th className="th text-right">Handled</th><th className="th text-right">Checkpoint</th><th className="th">Staleness</th></tr>
      </thead>
      <tbody className="divide-y divide-slate-100">
        {groups.map((g) =>
          g.streams.map((s, i) => (
            <tr key={`${g.group}-${s.family}`} className={i === 0 ? 'border-t-2 border-slate-100' : ''}>
              {i === 0 && (
                <td className="td align-top" rowSpan={g.streams.length}>
                  <div className="flex items-center gap-1.5 whitespace-nowrap"><span className="font-mono font-semibold">{g.group}</span><span className={`chip ${KIND[g.kind]}`}>{g.kind}</span></div>
                  <div className="mt-0.5 line-clamp-2 max-w-md text-xs text-slate-500" title={g.description}>{g.description}</div>
                  {g.tables.length > 0 && <div className="mt-0.5 font-mono text-[11px] text-slate-400">{g.tables.join(', ')}</div>}
                </td>
              )}
              <td className="td font-mono text-xs">{s.family}</td>
              <td className={`td text-right font-mono text-xs ${s.lag ? 'font-semibold text-amber-700' : ''}`}>{s.lag ?? '—'}</td>
              <td className={`td text-right font-mono text-xs ${s.pending ? 'font-semibold text-amber-700' : ''}`}>{s.pending}</td>
              <td className="td text-right font-mono text-xs">{s.eventsHandled.toLocaleString()}</td>
              <td className="td text-right font-mono text-xs">#{s.checkpointPosition.toLocaleString()}</td>
              <td className={`td text-xs ${s.stalenessSeconds > 5 ? 'font-semibold text-red-700' : 'text-slate-500'}`}>{staleText(s.stalenessSeconds)}{s.behindEvents ? ` · ${s.behindEvents} behind` : ''}</td>
            </tr>
          )),
        )}
      </tbody>
    </table>
  )
}
