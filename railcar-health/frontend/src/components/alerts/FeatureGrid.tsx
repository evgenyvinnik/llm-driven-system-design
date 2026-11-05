import { signed } from '@/lib/format'
import type { AlertFeatures } from '@/types'

export function FeatureGrid({ f }: { f: AlertFeatures }) {
  const items: Array<[string, string, string?]> = [
    ['Above ambient', `${Math.round(f.aboveAmbient ?? 0)}°F`, f.biasCorrected ? 'bias-corrected' : undefined],
    ['vs train-side median', `${signed(f.sideDelta)}°F`, `max ${signed(f.maxSideDelta)}°F`],
    ['Rise per 15 mi', f.risePer15mi === null || f.risePer15mi === undefined ? '—' : `${signed(f.risePer15mi)}°F`, `${f.observations ?? 0} readings`],
    ['Rank in train side', f.percentile ? `top ${Math.max(0.1, Math.round((100 - f.percentile) * 10) / 10)}%` : '—'],
    ['Consecutive elevated', String(f.consecutiveElevated ?? 0)],
    ['Prior trips elevated', String(f.historyElevatedTrips ?? 0)],
  ]
  if (f.wheelDelta !== undefined && Math.abs(f.wheelDelta) >= 50) items.push(['Wheel vs median', `${signed(f.wheelDelta)}°F`])
  if (f.coverageGap) items.push(['Coverage gap', `${f.maxGapMiles} mi`, 'silent/offline detector'])
  return (
    <dl className="grid grid-cols-3 gap-2">
      {items.map(([label, value, hint]) => (
        <div key={label} className="rounded-md bg-slate-50 px-2.5 py-2">
          <dt className="text-[11px] font-medium uppercase tracking-wide text-slate-500">{label}</dt>
          <dd className="text-sm font-semibold text-slate-900">{value}</dd>
          {hint && <dd className="text-[11px] text-slate-500">{hint}</dd>}
        </div>
      ))}
    </dl>
  )
}
