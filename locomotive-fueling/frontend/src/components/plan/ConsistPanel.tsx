import { Chip } from '@/components/shared/Chips'
import { FuelBar } from '@/components/shared/FuelBar'
import type { UnitView } from '@/types'

/** Each unit: smoothed level (what the planner uses), raw sensor, burn vs model, and flags. */
export function ConsistPanel({ units }: { units: UnitView[] }) {
  return (
    <div className="card p-4">
      <div className="panel-title mb-2">Consist</div>
      <div className="space-y-3">
        {units.map((u) => (
          <div key={u.locomotiveId}>
            <FuelBar unit={u} />
            <div className="num mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
              <span>
                {u.model} · {u.role}
              </span>
              <span>smoothed {u.fuelGal ?? '—'} gal</span>
              <span>raw {u.fuelRaw ?? '—'}</span>
              <span>notch {u.notch ?? '—'}</span>
              <span>burn ×{u.calibration.toFixed(2)} vs model</span>
              {u.sensorSuspect && <Chip kind="warn">Sensor faulty: dead reckoning</Chip>}
              {u.leakSuspect && <Chip kind="bad">Possible leak</Chip>}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
