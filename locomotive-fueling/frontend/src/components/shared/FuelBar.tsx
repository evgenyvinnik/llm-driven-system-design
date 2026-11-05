import type { UnitView } from '@/types'

/**
 * One unit's tank: fill to the smoothed level, a tick at reserve, and the
 * numeric level as text. Below reserve the fill turns red and the label says
 * so; color is never the only signal.
 */
export function FuelBar({ unit, compact = false }: { unit: UnitView; compact?: boolean }) {
  const pct = unit.fuelPct ?? 0
  const reservePct = (unit.reserveGal / unit.capacityGal) * 100
  const low = unit.fuelGal !== null && unit.fuelGal < unit.reserveGal
  const warn = !low && pct < reservePct * 2
  const fill = low ? 'bg-red-500' : warn ? 'bg-amber-500' : 'bg-accent-600'
  return (
    <div className={compact ? 'w-24' : 'w-full'} title={`${unit.locomotiveId}: ${unit.fuelGal ?? '—'} of ${unit.capacityGal} gal (reserve ${Math.round(unit.reserveGal)})`}>
      <div className="flex items-baseline justify-between text-[11px] text-slate-500">
        <span className="font-mono text-slate-700">{unit.locomotiveId}</span>
        <span className="num">
          {unit.fuelPct === null ? '—' : `${Math.round(pct)}%`}
          {low && <span className="ml-1 font-semibold text-red-700">LOW</span>}
        </span>
      </div>
      <div className="relative mt-0.5 h-2 rounded-full bg-slate-100">
        <div className={`h-2 rounded-full ${fill}`} style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />
        <div className="absolute top-[-2px] h-3 w-px bg-slate-500" style={{ left: `${reservePct}%` }} aria-hidden />
      </div>
    </div>
  )
}
