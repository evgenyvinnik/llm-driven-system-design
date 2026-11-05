import { createFileRoute } from '@tanstack/react-router'
import { PrecisionTable } from '@/components/admin/PrecisionTable'
import { ThresholdForm } from '@/components/admin/ThresholdForm'
import { ErrorNote, Loading } from '@/components/shared/Loading'
import { PageHeader, StatTile } from '@/components/shared/PageHeader'
import { lagText, pct } from '@/lib/format'
import { useFetch } from '@/lib/hooks'
import { api } from '@/services/api'
import { useLiveStore } from '@/stores/live-store'

export const Route = createFileRoute('/admin')({ component: AdminPage })

export function AdminPage() {
  const revision = useLiveStore((s) => s.revisions.alerts)
  const metrics = useFetch(() => api.metrics(), [revision])
  const thresholds = useFetch(() => api.thresholds(), [])
  const m = metrics.data
  return (
    <div className="page space-y-4">
      <PageHeader title="Reliability engineering" subtitle="Inspection findings are the labels: they measure how often each tier is right and drive threshold calibration. Seeded history is illustrative demo data." />
      {metrics.error && <ErrorNote message={metrics.error} />}
      {m && (
        <div className="grid grid-cols-5 gap-3">
          <StatTile label="Recall proxy" value={pct(m.recall.value)} hint={`${m.recall.alertedFirst} of ${m.recall.confirmedDefects} confirmed defects had a MEDIUM+ alert first`} />
          <StatTile label="Alert volume" value={m.alertVolume.per1000CarPasses === null ? '—' : m.alertVolume.per1000CarPasses.toFixed(1)} hint={`alerts per 1,000 car passes (${m.alertVolume.carPasses.toLocaleString()} car passes)`} />
          <StatTile label="Late passes" value={pct(m.ingest.passes ? m.ingest.late / m.ingest.passes : null)} hint={`${m.ingest.late} of ${m.ingest.passes} arrived >${m.ingest.lateAfterMinutes} min after the train; median lag ${lagText(m.ingest.median_lag ?? 0)}`} />
          <StatTile label="Open work" value={m.open.work} hint={`${m.open.holds} active holds · ${m.open.alerts} open alerts`} />
          <StatTile label="Unresolved passes" value={m.ingest.unresolved + m.ingest.awaiting} hint="axle count mismatch or waiting for a consist" />
        </div>
      )}
      <div className="grid grid-cols-5 gap-4">
        <section className="card col-span-2 overflow-hidden">
          <h2 className="border-b border-slate-100 px-4 py-2.5 text-sm font-semibold text-slate-900">Precision by tier (from inspection findings)</h2>
          {m ? <PrecisionTable rows={m.precisionByTier} /> : <Loading />}
          <p className="px-4 py-3 text-xs text-slate-500">Low precision at LOW is expected: it only asks for monitoring. If MEDIUM precision falls, yards spend inspections on healthy cars and start ignoring holds.</p>
        </section>
        <section className="card col-span-3 p-4">
          <h2 className="mb-3 text-sm font-semibold text-slate-900">Thresholds {thresholds.data && <span className="font-normal text-slate-500">· version {thresholds.data.version}{thresholds.data.updatedBy ? ` by ${thresholds.data.updatedBy}` : ''}</span>}</h2>
          {thresholds.data ? <ThresholdForm key={thresholds.data.version} initial={thresholds.data.config} version={thresholds.data.version} onSaved={thresholds.reload} /> : <Loading />}
        </section>
      </div>
    </div>
  )
}
