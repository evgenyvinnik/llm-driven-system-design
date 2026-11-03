/**
 * The dashboard. All state is in the URL; every widget derives its own query
 * (and cache key) from the same resolved filters, so changing a filter
 * re-keys every widget at once and nothing can show numbers for old filters.
 */
import { useCallback, useMemo } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { FilterBar } from '../components/filters/FilterBar'
import { BreakdownWidget } from '../components/widgets/BreakdownWidget'
import { DrilldownPanel } from '../components/widgets/DrilldownPanel'
import { ExportMenu } from '../components/widgets/ExportMenu'
import { KpiTiles } from '../components/widgets/KpiTiles'
import { LatencyWidget } from '../components/widgets/LatencyWidget'
import { TrendWidget } from '../components/widgets/TrendWidget'
import { canonicalString, parseSearch, resolveQuery, toggle, toUrlSearch, withoutDimension, type DashboardSearch, type ResolvedQuery } from '../lib/filters'
import { zoneAbbrev } from '../lib/format'
import { useDebounced, useNow } from '../lib/hooks'
import { useBreakdown, useLatency, useMeta, useOverview, useSeries } from '../lib/queries'
import { useSession } from '../stores/session'

type UrlSearch = ReturnType<typeof toUrlSearch>

export const Route = createFileRoute('/')({
  validateSearch: (raw: Record<string, unknown>): UrlSearch => toUrlSearch(parseSearch(raw)),
  component: Dashboard,
})

const sameQuery = (a: ResolvedQuery | null, b: ResolvedQuery | null) => (a && b ? canonicalString(a) === canonicalString(b) : a === b)

function Dashboard() {
  const urlSearch = Route.useSearch()
  const navigate = Route.useNavigate()
  const search = useMemo(() => parseSearch(urlSearch as Record<string, unknown>), [urlSearch])
  const orgs = useSession((s) => s.orgs)
  const access = orgs.find((o) => o.orgId === search.org) ?? orgs[0]
  const meta = useMeta()
  const now = useNow(20_000)

  const resolved = useMemo(
    () => (access ? resolveQuery(search, access.orgId, access.timeZone, now) : null),
    // `now` matters only when it crosses a bucket boundary; canonical comparison below keeps identity stable.
    [search, access, now],
  )
  // The screen follows the newest filters at once; requests follow the settled ones.
  const q = useDebounced(resolved, 200, sameQuery)

  const onChange = useCallback(
    (patch: Partial<DashboardSearch>, opts: { replace?: boolean } = {}) => {
      navigate({ search: (prev) => toUrlSearch({ ...parseSearch(prev as Record<string, unknown>), ...patch }), replace: opts.replace })
    },
    [navigate],
  )

  const billing = access?.permissions.includes('billing:read') ?? false
  const canDrill = access?.permissions.includes('drilldown:read') ?? false
  const metrics = (meta.data?.metrics ?? []).filter((m) => m.sensitivity !== 'billing' || billing)
  const metric = metrics.some((m) => m.id === search.metric) || !meta.data ? search.metric : 'conversations'
  const compareLabel = search.compare === 'wow' ? 'Previous week' : search.compare === 'mom' ? 'Previous month' : null

  const overview = useOverview(q)
  const series = useSeries(q, metric, !!meta.data)
  const latency = useLatency(q)
  const byModel = useBreakdown(q && withoutDimension(q, 'model'), metric, 'model')
  const byFeature = useBreakdown(q && withoutDimension(q, 'feature'), 'active_users', 'feature')

  if (!access) return <p className="text-sm text-ink-2">Your account has no organizations.</p>

  return (
    <div className="space-y-4">
      <FilterBar search={search} resolved={resolved} meta={meta.data} onChange={onChange}>
        <ExportMenu query={q} canExportConversations={canDrill} />
      </FilterBar>

      <KpiTiles query={overview} timeZone={access.timeZone} compareLabel={compareLabel} activeMetric={metric} onSelectMetric={(id) => onChange({ metric: id, drill: undefined })} />

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <TrendWidget
            query={series}
            metrics={metrics}
            metric={metric}
            onMetric={(id) => onChange({ metric: id, drill: undefined })}
            compareLabel={compareLabel}
            drill={search.drill}
            onDrill={canDrill ? (b) => onChange({ drill: b.start }) : undefined}
          />
        </div>
        <BreakdownWidget title="Feature adoption" query={byFeature} selected={search.features} onToggle={(k) => onChange({ features: toggle(search.features, k), drill: undefined }, { replace: true })} shareLabel="of active users" />
      </div>

      {search.drill && q && (
        <DrilldownPanel key={`${search.drill}|${metric}`} query={q} metric={metric} bucket={search.drill} timeZone={access.timeZone} onClose={() => onChange({ drill: undefined })} />
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <LatencyWidget query={latency} grain={q?.grain ?? 'day'} timeZone={access.timeZone} />
        </div>
        <BreakdownWidget title="By model" query={byModel} selected={search.models} onToggle={(k) => onChange({ models: toggle(search.models, k), drill: undefined }, { replace: true })} />
      </div>

      <p className="text-xs text-ink-muted">
        Times are in {access.orgName}’s time zone, {access.timeZone} ({zoneAbbrev(access.timeZone)}). Daily buckets are calendar days there.
        {!billing && ' Cost metrics are not available for your role.'}
      </p>
    </div>
  )
}
