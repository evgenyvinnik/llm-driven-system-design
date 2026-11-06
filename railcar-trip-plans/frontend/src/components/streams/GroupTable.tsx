import { fmtClock } from '@/lib/format'
import type { GroupStat } from '@/types'

const short = (s: string) => s.replace(/^tp:/, '')

function staleness(s: number) {
  if (s === 0) return <span className="text-emerald-700">caught up</span>
  return <span className={s > 30 ? 'font-semibold text-red-700' : 'text-amber-700'}>{s < 120 ? `${s} s` : `${Math.round(s / 60)} min`}</span>
}

/** Consumer lag, pending, staleness and DLQ depth per group, with per-partition detail and lease owners. */
export function GroupTable({ groups }: { groups: GroupStat[] }) {
  return (
    <table className="w-full" aria-label="Consumer groups">
      <thead className="border-b border-slate-200 bg-slate-50">
        <tr>
          <th className="th">Consumer group</th>
          <th className="th">Reads</th>
          <th className="th text-right">Lag</th>
          <th className="th text-right">Pending</th>
          <th className="th">Projection staleness</th>
          <th className="th text-right">DLQ</th>
          <th className="th text-right">Processed</th>
          <th className="th text-right">Duplicates dropped</th>
          <th className="th">Partitions: lag / pending (all leased by #1)</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-100">
        {groups.map((g) => (
          <tr key={g.group}>
            <td className="td">
              <div className="whitespace-nowrap font-mono text-sm font-semibold">{g.group}</div>
              <div className="whitespace-nowrap text-[11px] text-slate-400">last commit {fmtClock(g.lastProcessedAt)}</div>
            </td>
            <td className="td whitespace-nowrap text-xs">{g.topics.join(' + ')}</td>
            <td className={`td text-right font-mono ${g.lag > 0 ? 'text-amber-700' : ''}`}>{g.lag}</td>
            <td className={`td text-right font-mono ${g.pending > 0 ? 'text-amber-700' : ''}`}>{g.pending}</td>
            <td className="td text-sm">{staleness(g.stalenessSeconds)}</td>
            <td className={`td text-right font-mono ${g.dlqDepth > 0 ? 'font-semibold text-red-700' : ''}`}>{g.dlqDepth}</td>
            <td className="td text-right font-mono">{g.processed.toLocaleString()}</td>
            <td className="td text-right font-mono">{g.duplicates}</td>
            <td className="td">
              <div className="flex max-w-xl flex-wrap gap-1">
                {g.streams.map((s) => {
                  const owner = g.owners.find((o) => o.stream === s.stream)?.owner
                  return (
                    <span key={s.stream} className={`chip ${s.lag || s.pending ? 'bg-amber-50 text-amber-800' : 'bg-slate-100 text-slate-600'}`} title={`${s.stream}: lag ${s.lag}, pending ${s.pending}, owner ${owner ?? 'none'}`}>
                      {short(s.stream).replace(`retry:${g.group}`, 'retry')} {s.lag}/{s.pending}
                      {s.stream.includes(':retry:') ? '' : owner ? '' : ' · unowned'}
                    </span>
                  )
                })}
              </div>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
