import { createFileRoute, Link } from '@tanstack/react-router'
import { useEffect } from 'react'
import { ErrorNote, Loading } from '@/components/shared/Loading'
import { PageHeader } from '@/components/shared/PageHeader'
import { TierBadge } from '@/components/shared/TierBadge'
import { ageText, timeText } from '@/lib/format'
import { useFetch, useTicker } from '@/lib/hooks'
import { api } from '@/services/api'
import { useClockStore } from '@/stores/clock-store'
import { useLiveStore } from '@/stores/live-store'

export const Route = createFileRoute('/trains/')({ component: TrainsPage })

export function TrainsPage() {
  const revision = useLiveStore((s) => s.revisions.trips)
  const { data, error } = useFetch(() => api.trips(), [revision])
  const nowMs = useClockStore((s) => s.now)()
  useTicker()
  useEffect(() => {
    if (data) useClockStore.getState().update(data.clock)
  }, [data])
  return (
    <div className="page">
      <PageHeader title="Trains" subtitle="Trips with detector data, newest first. Open one for the axle-by-detector heatmap." />
      {error && <ErrorNote message={error} />}
      {!data ? <Loading /> : (
        <table className="card w-full overflow-hidden" aria-label="Trains">
          <thead className="border-b border-slate-100 bg-slate-50">
            <tr><th className="th">Train</th><th className="th">Route</th><th className="th">Status</th><th className="th">Territory</th><th className="th">Next yard</th><th className="th">Cars</th><th className="th">Open alerts</th></tr>
          </thead>
          <tbody className="divide-y divide-slate-100 bg-white">
            {data.trips.map((t) => (
              <tr key={t.tripId} className="hover:bg-slate-50">
                <td className="td"><Link to="/trains/$tripId" params={{ tripId: t.tripId }} className="font-mono font-semibold text-accent-700 hover:underline">{t.symbol}</Link> <span className="text-xs text-slate-500">{t.direction}</span></td>
                <td className="td">{t.originYardId} → {t.destinationYardId}</td>
                <td className="td">{t.status === 'arrived' ? `Arrived ${ageText(t.arrivedAt, nowMs)}` : `MP ${t.lastMilepost ?? '—'} · ${ageText(t.lastPassAt, nowMs)}`}</td>
                <td className="td">{t.territoryId ?? '—'}</td>
                <td className="td">{t.status === 'arrived' ? '—' : `${t.nextYardId ?? '—'} ${t.nextYardEta ? timeText(t.nextYardEta) : ''}`}</td>
                <td className="td">{t.carCount ?? '—'}</td>
                <td className="td">{t.openAlerts > 0 && t.maxTier ? <span className="flex items-center gap-2"><TierBadge tier={t.maxTier} /> {t.openAlerts}</span> : <span className="text-slate-400">none</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
