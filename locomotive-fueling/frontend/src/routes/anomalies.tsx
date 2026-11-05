import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { AlertList } from '@/components/anomalies/AlertList'
import { SensorChart } from '@/components/anomalies/SensorChart'
import { ErrorNote, Loading } from '@/components/shared/Loading'
import { useRefresh } from '@/lib/use-refresh'
import { api } from '@/services/api'
import { useAuthStore } from '@/stores/auth-store'
import { useLiveStore } from '@/stores/live-store'
import type { AlertRow } from '@/types'

export const Route = createFileRoute('/anomalies')({ component: Anomalies })

const UNIT_ALERTS = new Set(['sensor_fault', 'leak_suspected', 'low_fuel'])

function Anomalies() {
  const role = useAuthStore((s) => s.user?.role)
  const tick = useLiveStore((s) => s.ticks.alert)
  const { data, error, reload } = useRefresh(() => api.alerts('open'), { triggers: [tick], coalesceMs: 1500 })
  const [picked, setPicked] = useState<AlertRow | null>(null)
  const focus = picked ?? data?.alerts.find((a) => UNIT_ALERTS.has(a.type) && a.locomotiveId) ?? null
  const telemetry = useRefresh(() => (focus?.trainId ? api.telemetry(focus.trainId, 160) : Promise.resolve({ readings: [] })), { triggers: [focus?.id] })
  if (!data) return error ? <ErrorNote message={error} /> : <Loading />
  const unitReadings = (telemetry.data?.readings ?? []).filter((r) => r.locomotiveId === focus?.locomotiveId)
  return (
    <div className="space-y-4 p-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">Anomalies</h1>
        <p className="text-sm text-slate-500">
          Raised from telemetry by the stream processor, independent of the planner: low fuel, suspected leaks or theft, faulty sensors, range risk, vendor and ticket problems.
        </p>
      </div>
      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        <AlertList alerts={[...data.alerts].sort((a, b) => Number(UNIT_ALERTS.has(b.type)) - Number(UNIT_ALERTS.has(a.type)))} selected={focus?.id ?? null} onSelect={setPicked} canAck={role !== 'crew'} onChanged={reload} />
        <div className="card sticky top-4 p-4">
          <div className="panel-title mb-2">
            {focus?.locomotiveId ? `Unit ${focus.locomotiveId}: raw sensor vs smoothed level (last ${unitReadings.length} readings)` : 'Select a unit alert to see its sensor trace'}
          </div>
          {focus?.locomotiveId && <SensorChart readings={unitReadings} />}
        </div>
      </div>
    </div>
  )
}
