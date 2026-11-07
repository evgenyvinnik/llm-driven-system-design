import { fmtClock } from '@/lib/format'
import type { StreamsOverview } from '@/types'

/** Events per second over the last five minutes (5 s buckets, wall clock). */
export function RateSparkline({ series }: { series: StreamsOverview['rates']['series'] }) {
  if (series.length < 2) return <div className="h-12 text-xs text-slate-400">no recent traffic</div>
  const W = 260
  const H = 48
  const max = Math.max(...series.map((s) => s.perSecond), 1)
  const t0 = Date.parse(series[0].at)
  const t1 = Date.parse(series[series.length - 1].at)
  const pts = series.map((s) => `${(((Date.parse(s.at) - t0) / Math.max(1, t1 - t0)) * W).toFixed(1)},${(H - (s.perSecond / max) * (H - 4)).toFixed(1)}`).join(' ')
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-12 w-full" role="img" aria-label="Events per second">
      <polyline points={pts} fill="none" stroke="#2a78d6" strokeWidth="1.5" />
      <text x={W} y={10} textAnchor="end" fontSize="9" fill="#64748b">peak {max}/s</text>
    </svg>
  )
}

export function TopicTable({ topics }: { topics: StreamsOverview['topics'] }) {
  return (
    <table className="w-full" aria-label="Topics">
      <thead className="border-b border-slate-200 bg-slate-50">
        <tr>
          <th className="th">Topic (key)</th>
          <th className="th">Partition</th>
          <th className="th text-right">Entries</th>
          <th className="th">Last append</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-100">
        {topics.flatMap((t) =>
          t.partitions.map((p, i) => (
            <tr key={p.stream}>
              <td className="td text-sm">{i === 0 ? `${t.topic} (${t.topic === 'car' ? 'car id' : t.topic === 'train' ? 'train run' : 'shipper'})` : ''}</td>
              <td className="td font-mono text-xs">{p.stream}</td>
              <td className="td text-right font-mono">{p.length.toLocaleString()}</td>
              <td className="td mono">{fmtClock(p.lastAt)}</td>
            </tr>
          )),
        )}
      </tbody>
    </table>
  )
}

/** Event counts by type and schema version: CarSighted shows v1 (old readers) next to v2. */
export function EventTypeTable({ types }: { types: StreamsOverview['eventTypes'] }) {
  return (
    <ul className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-xs">
      {types.map((t) => (
        <li key={`${t.type}-${t.version}`} className="flex justify-between border-b border-slate-50 py-0.5">
          <span>
            {t.type} <span className={t.type === 'CarSighted' ? 'font-semibold text-amber-700' : 'text-slate-400'}>v{t.version}</span>
          </span>
          <span className="font-mono">{t.n.toLocaleString()}</span>
        </li>
      ))}
    </ul>
  )
}

export function ReplayTable({ replays }: { replays: StreamsOverview['replays'] }) {
  if (replays.length === 0) return <p className="text-sm text-slate-500">No replays yet. Run <code>npm run replay -- all</code> in backend/.</p>
  return (
    <table className="w-full" aria-label="Replays">
      <thead className="border-b border-slate-200 bg-slate-50">
        <tr>
          <th className="th">Projection</th>
          <th className="th">Finished</th>
          <th className="th text-right">Inputs</th>
          <th className="th text-right">Rows live / rebuilt</th>
          <th className="th">Result</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-100">
        {replays.map((r) => (
          <tr key={r.id}>
            <td className="td font-mono text-sm">{r.projection}</td>
            <td className="td mono">{fmtClock(r.finished_at)}</td>
            <td className="td text-right font-mono">{r.events_read}</td>
            <td className="td text-right font-mono">{r.rows_live} / {r.rows_rebuilt}</td>
            <td className="td">
              {r.matches ? <span className="chip bg-emerald-50 text-emerald-800">identical</span> : <span className="chip bg-red-50 text-red-700">different</span>}
              {r.applied && <span className="chip ml-1 bg-slate-100 text-slate-600">applied</span>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
