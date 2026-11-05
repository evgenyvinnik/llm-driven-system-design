import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { DetectorDetail } from '@/components/detectors/DetectorDetail'
import { DetectorTable } from '@/components/detectors/DetectorTable'
import { StripMap } from '@/components/detectors/StripMap'
import { ErrorNote, Loading } from '@/components/shared/Loading'
import { PageHeader } from '@/components/shared/PageHeader'
import { useFetch, useTicker } from '@/lib/hooks'
import { api } from '@/services/api'
import { useClockStore } from '@/stores/clock-store'
import { useLiveStore } from '@/stores/live-store'

export const Route = createFileRoute('/detectors')({ component: DetectorsPage })

export function DetectorsPage() {
  const revision = useLiveStore((s) => s.revisions.detectors + s.revisions.trips)
  const { data, error } = useFetch(() => api.network(), [revision])
  const [selected, setSelected] = useState<string | null>(null)
  const nowMs = useClockStore((s) => s.now)()
  useTicker()
  useEffect(() => {
    if (data) useClockStore.getState().update(data.clock)
  }, [data])
  if (error) return <div className="page"><ErrorNote message={error} /></div>
  if (!data) return <Loading />
  const problems = data.detectors.filter((d) => d.status !== 'ok').length
  return (
    <div className="page space-y-4">
      <PageHeader
        title="Detector health"
        subtitle={`${data.detectors.length} hot bearing detectors, ${problems} need attention. A biased detector shifts absolute temperatures; a silent one leaves a gap trends must not paper over; an offline gateway is buffering data that will arrive late.`}
      />
      <div className="grid grid-cols-[1fr_340px] gap-4">
        <section className="card overflow-x-auto p-4">
          <StripMap network={data} selected={selected} onSelect={setSelected} />
          <p className="mt-2 text-xs text-slate-500">
            Analyzer lanes: live {data.lanes.live ?? '—'} queued · backfill {data.lanes.backfill ?? '—'} queued. A reconnecting site's backlog goes to the backfill lane, so it never delays fresh readings.
          </p>
        </section>
        <section className="card max-h-[260px] overflow-y-auto p-4">
          <h2 className="mb-3 text-sm font-semibold text-slate-900">{selected ?? 'Select a detector'}</h2>
          {selected ? <DetectorDetail id={selected} revision={revision} /> : <p className="text-sm text-slate-500">Click a detector on the map or in the table.</p>}
        </section>
      </div>
      <section className="card overflow-hidden"><DetectorTable detectors={data.detectors} nowMs={nowMs} selected={selected} onSelect={setSelected} /></section>
    </div>
  )
}
