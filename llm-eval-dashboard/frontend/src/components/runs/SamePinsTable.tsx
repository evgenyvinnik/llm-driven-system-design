import { Link } from '@tanstack/react-router'
import { score } from '@/lib/format'
import type { RunDetail } from '@/types'

/** Runs with identical pins except the sample count: more samples per case → a narrower interval. */
export function SamePinsTable({ detail, scorerVersionId }: { detail: RunDetail; scorerVersionId: string | null }) {
  if (detail.samePins.length < 2 || !scorerVersionId) return null
  const rows = detail.samePins.map((p) => ({ ...p, s: p.scorers.find((x) => x.scorerVersionId === scorerVersionId) })).filter((p) => p.s)
  if (rows.length < 2) return null
  const widest = Math.max(...rows.map((r) => r.s?.ciHalfWidth ?? 0), 0.001)
  return (
    <div className="card p-4">
      <div className="panel-title mb-2">Same pins, different sample counts</div>
      <table className="w-full text-sm" aria-label="Same pins">
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className={r.id === detail.run.id ? 'font-semibold' : ''}>
              <td className="py-1 pr-3">
                <Link to="/runs/$runId" params={{ runId: r.id }} className="text-accent-700 hover:underline">
                  ×{r.samplesPerCase} samples
                </Link>
              </td>
              <td className="num py-1 pr-3">{score(r.s?.mean ?? null)}</td>
              <td className="num py-1 pr-3 text-slate-600">± {r.s?.ciHalfWidth !== null && r.s?.ciHalfWidth !== undefined ? r.s.ciHalfWidth.toFixed(3) : '—'}</td>
              <td className="w-1/2 py-1">
                <div className="h-2 rounded-full bg-accent-200" style={{ width: `${((r.s?.ciHalfWidth ?? 0) / widest) * 100}%` }} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 text-[11px] text-slate-500">The interval is over cases; extra samples shrink the per-case noise, not the spread between easy and hard cases.</p>
    </div>
  )
}
