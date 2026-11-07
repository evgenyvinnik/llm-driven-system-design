import { createFileRoute } from '@tanstack/react-router'
import { FlagHeader } from '@/components/editor/FlagHeader'
import { ArmsTable } from '@/components/results/ArmsTable'
import { AssignedVsExposed } from '@/components/results/AssignedVsExposed'
import { EventHealth } from '@/components/results/EventHealth'
import { SrmBanner } from '@/components/results/SrmBanner'
import { Loading } from '@/components/shared/Loading'
import { num } from '@/lib/format'
import { useFlag } from '@/lib/use-flag'
import { usePoll } from '@/lib/use-poll'
import { api } from '@/services/api'
import { useEnvStore } from '@/stores/env-store'

export const Route = createFileRoute('/flags/$key/results')({ component: ResultsPage })

function ResultsPage() {
  const { key } = Route.useParams()
  const env = useEnvStore((s) => s.env)
  const { data: flag } = useFlag(key)
  const { data: results, error } = usePoll(() => api.results(key, env), 5000, [key, env])
  if (!flag) return <Loading />
  const names = Object.fromEntries(flag.variants.map((v) => [v.key, v.name]))
  return (
    <div className="page max-w-7xl">
      <FlagHeader flag={flag} env={env} tab="results" />
      {error && !results && <p className="text-sm text-rose-700">{error}</p>}
      {!results ? (
        !error && <Loading label="Computing results from ClickHouse…" />
      ) : (
        <div className="space-y-4" data-ready="true">
          <SrmBanner exposed={results.exposed} assigned={results.assigned} />
          <section className="card overflow-hidden">
            <div className="flex flex-wrap items-baseline justify-between gap-2 px-4 pt-4">
              <h2 className="panel-title">Exposed units: {results.flag.primaryMetric} within {results.flag.attributionWindowHours} h of first exposure</h2>
              <span className="text-xs text-slate-500">
                {num(results.exposed.totalUnits)} exposed units · {num(results.exposed.crossovers)} crossovers excluded from rates · α = 0.05, two-sided
              </span>
            </div>
            <div className="mt-3">
              <ArmsTable analysis={results.exposed} names={names} label="Exposed analysis" />
            </div>
          </section>
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_420px]">
            <AssignedVsExposed assigned={results.assigned} exposed={results.exposed} surface={results.flag.surface} />
            <EventHealth results={results} />
          </div>
        </div>
      )}
    </div>
  )
}
