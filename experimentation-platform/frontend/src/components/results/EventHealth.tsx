import { dateTime, num } from '@/lib/format'
import type { Results } from '@/types'

export function EventHealth({ results }: { results: Results }) {
  const { exposures, assignments, conversions, lateThresholdMinutes } = results.events
  const row = (label: string, c: typeof exposures) => (
    <tr>
      <td className="py-1 text-slate-600">{label}</td>
      <td className="num text-right">{num(c.rows)}</td>
      <td className="num text-right">{num(c.unique)}</td>
      <td className="num text-right">{c.rows > c.unique ? <span className="text-amber-700">{num(c.rows - c.unique)}</span> : '0'}</td>
      <td className="num text-right">{num(c.late)}</td>
    </tr>
  )
  return (
    <section className="card space-y-2 p-4" aria-label="Event health">
      <h2 className="panel-title">Event health</h2>
      <table className="w-full text-xs" aria-label="Event counts">
        <thead>
          <tr className="text-left text-slate-500">
            <th className="py-1 font-medium">Table</th>
            <th className="py-1 text-right font-medium">Rows</th>
            <th className="py-1 text-right font-medium">Distinct events</th>
            <th className="py-1 text-right font-medium">Unmerged duplicates</th>
            <th className="py-1 text-right font-medium">Late (&gt;{lateThresholdMinutes} min)</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {row('exposures', exposures)}
          {row('assignments', assignments)}
          {row(`conversions (${results.flag.primaryMetric})`, conversions)}
        </tbody>
      </table>
      <p className="text-[11px] leading-relaxed text-slate-500">
        A conversion counts if it happens after the unit’s first exposure and within {results.flag.attributionWindowHours} h. Duplicates (an SDK re-sending an event in a new batch) collapse in
        ClickHouse at merge time; every number above the fold uses distinct units, so they never inflate results. Late events are included as soon as they arrive. Data through{' '}
        {dateTime(exposures.dataThrough)}; computed {dateTime(results.computedAt)}.
      </p>
    </section>
  )
}
