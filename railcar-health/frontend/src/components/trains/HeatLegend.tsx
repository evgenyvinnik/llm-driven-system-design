import { HEAT_RAMP, HEAT_SCALE, type HeatMode } from '@/lib/heat'

export function HeatLegend({ mode }: { mode: HeatMode }) {
  const [min, max] = HEAT_SCALE[mode]
  return (
    <div className="flex items-center gap-2 text-xs text-slate-500">
      <span>{mode === 'ambient' ? 'Above ambient' : 'vs rail median'}</span>
      <span>{min > 0 ? `≤${min}` : min}°F</span>
      <div className="flex overflow-hidden rounded">
        {HEAT_RAMP.map((c) => <span key={c} className="h-3 w-5" style={{ background: c }} />)}
      </div>
      <span>≥{max}°F</span>
      <span className="ml-3 inline-block h-3 w-3 border-[1.5px] border-slate-900" /> alerted bearing
      <span className="ml-2 inline-block h-3 w-3 bg-slate-200" /> no reading
    </div>
  )
}
