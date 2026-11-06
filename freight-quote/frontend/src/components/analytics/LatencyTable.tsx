import { DEPENDENCY_LABEL, ms } from '@/lib/format'
import type { Analytics } from '@/types'

const LABEL: Record<string, string> = { ...DEPENDENCY_LABEL, quote_endpoint: 'POST /quotes (end to end)', firm_completion: 'Request → firm (async)' }
const fmt = (v: number | 'inf' | null) => (v === 'inf' ? '> 30 s' : ms(v))

export function LatencyTable({ latency, sources }: { latency: Analytics['latency']; sources: Analytics['sources'] }) {
  const order = ['quote_endpoint', 'pricing', 'fuel', 'capacity', 'availability', 'firm_completion']
  const rows = [...latency].sort((a, b) => order.indexOf(a.dependency) - order.indexOf(b.dependency))
  const mix = (dep: string) => {
    const s = sources.filter((x) => x.dependency === dep)
    const total = s.reduce((a, x) => a + x.count, 0)
    return total ? s.map((x) => `${x.source} ${Math.round((x.count / total) * 100)}%`).join(' · ') : '—'
  }
  return (
    <table className="w-full" aria-label="Latency by dependency">
      <thead className="bg-slate-50">
        <tr>
          <th className="th">Measured</th>
          <th className="th text-right">Samples</th>
          <th className="th text-right">p50</th>
          <th className="th text-right">p95</th>
          <th className="th text-right">p99</th>
          <th className="th">Component source mix</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-100">
        {rows.map((r) => (
          <tr key={r.dependency}>
            <td className="td font-medium">{LABEL[r.dependency] ?? r.dependency}</td>
            <td className="td text-right tabular-nums">{r.count}</td>
            <td className="td text-right tabular-nums">{fmt(r.p50)}</td>
            <td className="td text-right tabular-nums">{fmt(r.p95)}</td>
            <td className="td text-right tabular-nums font-semibold">{fmt(r.p99)}</td>
            <td className="td text-xs text-slate-500">{mix(r.dependency)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
