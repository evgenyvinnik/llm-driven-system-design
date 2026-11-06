import { createFileRoute } from '@tanstack/react-router'
import { LatencyTable } from '@/components/analytics/LatencyTable'
import { VolumeChart } from '@/components/analytics/VolumeChart'
import { PageHeader } from '@/components/shared/PageHeader'
import { ErrorNote, Loading } from '@/components/shared/Loading'
import { Stat } from '@/components/shared/Badges'
import { CLASS_LABEL, pct } from '@/lib/format'
import { usePolling } from '@/lib/hooks'
import { api } from '@/services/api'

export const Route = createFileRoute('/analytics')({ component: AnalyticsPage })

export function AnalyticsPage() {
  const { data, error } = usePolling(() => api.analytics(), 5000)
  if (!data) return error ? <div className="page"><ErrorNote message={error} /></div> : <Loading />
  const c = data.conversion
  const total = (metric: string, dim?: string) => data.totals.filter((t) => t.metric === metric && (!dim || t.dimension === dim)).reduce((s, t) => s + t.value, 0)
  return (
    <div className="page">
      <PageHeader
        title="Analytics"
        subtitle="A read model built only from the event log by the projector (bucketed by event time), never from the quotes table. Replaying the log from position 0 rebuilds exactly these numbers."
      />
      <div className="mb-4 grid grid-cols-6 gap-3">
        <Stat label="Requested" value={c.requested} />
        <Stat label="Firm quotes" value={c.firmQuotes} hint="issued firm + completed firm asynchronously" />
        <Stat label="Booked" value={c.booked} />
        <Stat label="Conversion" value={pct(c.rate, 1)} hint="booked ÷ firm quotes" />
        <Stat label="Expired" value={c.expired} />
        <Stat label="Re-priced" value={total('repriced')} hint="open indicative quotes re-priced by TariffPublished / FuelSurchargeChanged" />
      </div>
      <section className="card mb-4 p-4">
        <div className="panel-title mb-2">Quote requests per hour, by client class (last 24 h)</div>
        <VolumeChart hourly={data.hourly} />
        <table className="mt-3 w-full text-xs" aria-label="Requests by class">
          <tbody>
            <tr className="text-slate-600">
              {(['portal', 'api', 'api_requote'] as const).map((k) => (
                <td key={k} className="py-1">
                  {CLASS_LABEL[k]} (all time): <span className="tabular-nums font-semibold text-slate-900">{total('requested', k)}</span>
                </td>
              ))}
              <td className="py-1">
                Issued indicative: <span className="tabular-nums font-semibold text-slate-900">{total('issued', 'indicative')}</span>
              </td>
              <td className="py-1">
                Circuit opened: <span className="tabular-nums font-semibold text-slate-900">{total('circuit_opened')}</span>
              </td>
            </tr>
          </tbody>
        </table>
      </section>
      <section className="card overflow-hidden">
        <div className="border-b border-slate-100 px-4 py-2.5 panel-title">Latency per dependency (from QuoteIssued v2 provenance; v1 events carry none)</div>
        <LatencyTable latency={data.latency} sources={data.sources} />
      </section>
    </div>
  )
}
