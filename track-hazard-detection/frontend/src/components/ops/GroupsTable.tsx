import type { GroupInfo } from '@/types'

/** Consumer lag per (topic, group), summed over partitions. Lag = entries not yet delivered to the group. */
export function GroupsTable({ groups }: { groups: GroupInfo[] }) {
  const rows = new Map<string, { topic: string; group: string; partitions: number; length: number; lag: number; pending: number; consumers: number }>()
  for (const g of groups) {
    const k = `${g.topic}|${g.group}`
    const r = rows.get(k) ?? { topic: g.topic, group: g.group, partitions: 0, length: 0, lag: 0, pending: 0, consumers: 0 }
    r.partitions += 1
    r.length += g.length
    r.lag += g.lag ?? 0
    r.pending += g.pending
    r.consumers = Math.max(r.consumers, g.consumers)
    rows.set(k, r)
  }
  return (
    <table className="min-w-full" aria-label="Consumer groups">
      <thead className="bg-slate-50">
        <tr>
          <th className="th">Topic (stream)</th>
          <th className="th">Consumer group</th>
          <th className="th">Partitions</th>
          <th className="th">Entries</th>
          <th className="th">Lag</th>
          <th className="th">Pending (unacked)</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-100">
        {[...rows.values()].map((r) => (
          <tr key={`${r.topic}|${r.group}`}>
            <td className="td font-mono text-xs">th:{r.topic}:0..{r.partitions - 1}</td>
            <td className="td font-medium">{r.group}</td>
            <td className="td">{r.partitions}</td>
            <td className="td">{r.length.toLocaleString()}</td>
            <td className="td">
              <span className={`chip ${r.lag > 100 ? 'bg-red-100 text-red-800' : r.lag > 0 ? 'bg-amber-100 text-amber-800' : 'bg-emerald-50 text-emerald-700'}`}>{r.lag.toLocaleString()}</span>
            </td>
            <td className="td">{r.pending}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
