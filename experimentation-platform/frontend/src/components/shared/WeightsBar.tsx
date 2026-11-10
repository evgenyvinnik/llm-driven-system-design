/**
 * The 10,000 buckets as a bar, each variant's ranges drawn where they really
 * are, so a stable-range ramp is visibly "growing into" free or released space.
 */
import { BUCKETS, type Allocation } from '@exp/core'
import { VARIANT_COLORS } from '@/lib/format'

export function WeightsBar({ allocation, variants, height = 'h-3', label }: { allocation: Allocation; variants: string[]; height?: string; label?: string }) {
  return (
    <div className={`relative w-full overflow-hidden rounded bg-slate-100 ${height}`} role="img" aria-label={label ?? 'Bucket allocation'}>
      {variants.flatMap((v, i) =>
        (allocation[v] ?? []).map(([s, e]) => (
          <div
            key={`${v}-${s}`}
            className={`absolute inset-y-0 ${VARIANT_COLORS[i % VARIANT_COLORS.length]}`}
            style={{ left: `${(s / BUCKETS) * 100}%`, width: `${((e - s) / BUCKETS) * 100}%` }}
            title={`${v}: buckets ${s}–${e - 1}`}
          />
        )),
      )}
    </div>
  )
}

export function VariantLegend({ variants, weights }: { variants: { key: string; name: string }[]; weights?: Record<string, number> }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600">
      {variants.map((v, i) => (
        <span key={v.key} className="inline-flex items-center gap-1.5">
          <span className={`h-2.5 w-2.5 rounded-sm ${VARIANT_COLORS[i % VARIANT_COLORS.length]}`} />
          <span className="font-mono">{v.key}</span>
          {weights && <span className="num text-slate-400">{((weights[v.key] ?? 0) / 100).toFixed(weights[v.key] % 100 ? 2 : 0)}%</span>}
        </span>
      ))}
      <span className="inline-flex items-center gap-1.5">
        <span className="h-2.5 w-2.5 rounded-sm bg-slate-100 ring-1 ring-slate-200" /> not enrolled
      </span>
    </div>
  )
}
