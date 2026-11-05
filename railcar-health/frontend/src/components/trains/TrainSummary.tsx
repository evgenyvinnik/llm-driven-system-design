import { ageText, timeText } from '@/lib/format'
import type { Trip } from '@/types'

export function TrainSummary({ trip, nowMs }: { trip: Trip; nowMs: number }) {
  const items: Array<[string, string]> = [
    ['Route', `${trip.originYardId} → ${trip.destinationYardId} (stops ${trip.stops.join(', ')})`],
    ['Status', trip.status === 'arrived' ? `Arrived ${trip.arrivedYardId} ${ageText(trip.arrivedAt, nowMs)}` : `En route, last seen MP ${trip.lastMilepost ?? '—'} ${ageText(trip.lastPassAt, nowMs)}`],
    ['Territory', trip.territoryId ?? '—'],
    ['Next yard', trip.status === 'arrived' ? '—' : `${trip.nextYardId ?? '—'}${trip.nextYardEta ? ` ETA ${timeText(trip.nextYardEta)}` : ''}`],
    ['Cars', String(trip.carCount ?? '—')],
    ['Speed', trip.speedMph ? `${trip.speedMph} mph` : '—'],
  ]
  return (
    <dl className="grid grid-cols-6 gap-3">
      {items.map(([k, v]) => (
        <div key={k} className="card px-3 py-2">
          <dt className="panel-title">{k}</dt>
          <dd className="mt-0.5 text-sm font-medium text-slate-800">{v}</dd>
        </div>
      ))}
    </dl>
  )
}
