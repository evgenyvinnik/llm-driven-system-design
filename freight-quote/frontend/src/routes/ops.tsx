import { createFileRoute } from '@tanstack/react-router'
import { ClassTable } from '@/components/ops/ClassTable'
import { DependencyCard } from '@/components/ops/DependencyCard'
import { KnobsPanel } from '@/components/ops/KnobsPanel'
import { PricingActions } from '@/components/ops/PricingActions'
import { SettingsPanel } from '@/components/ops/SettingsPanel'
import { PageHeader } from '@/components/shared/PageHeader'
import { ErrorNote, Loading } from '@/components/shared/Loading'
import { Stat } from '@/components/shared/Badges'
import { pct } from '@/lib/format'
import { usePolling } from '@/lib/hooks'
import { api } from '@/services/api'
import { useAuthStore } from '@/stores/auth-store'
import { DEPENDENCIES } from '@/types'

export const Route = createFileRoute('/ops')({ component: OpsPage })

export function OpsPage() {
  const user = useAuthStore((s) => s.user)
  const { data, error, reload } = usePolling(() => api.overview(), 2000)
  if (!data) return error ? <div className="page"><ErrorNote message={error} /></div> : <Loading />
  const classes = Object.values(data.quotes)
  const total = classes.reduce((s, c) => s + c.firm + c.indicative + c.unavailable, 0)
  const indicative = classes.reduce((s, c) => s + c.indicative, 0)
  const shed = classes.reduce((s, c) => s + c.shed + c.rate_limited, 0)
  const inflight = data.instances.reduce((s, i) => s + i.inflight, 0)
  const open = DEPENDENCIES.filter((d) => data.dependencies[d].breaker !== 'closed')
  return (
    <div className="page">
      <PageHeader
        title="Operations"
        subtitle="Per-dependency latency and breakers as the quote API sees them, the cache, shedding by client class, and the knobs that inject slowness."
        actions={
          <button type="button" className="btn-secondary" onClick={() => void api.resetStats().then(reload)}>
            Reset counters
          </button>
        }
      />
      <ErrorNote message={error} />
      <div className="mb-4 grid grid-cols-5 gap-3">
        <Stat label="API instances" value={data.instances.length} hint={data.instances.map((i) => i.id).join(', ')} />
        <Stat label="In flight" value={inflight} />
        <Stat label="Quotes issued" value={total} />
        <Stat label="Indicative share" value={total ? pct(indicative / total) : '—'} tone={indicative / Math.max(1, total) > 0.2 ? 'bad' : 'default'} />
        <Stat label="Refused (shed + 429)" value={shed} tone={shed > 0 ? 'bad' : 'default'} hint={open.length ? `open circuits: ${open.join(', ')}` : undefined} />
      </div>
      <div className="grid grid-cols-[1fr,340px] gap-5">
        <div className="min-w-0 space-y-4">
          <div className="grid grid-cols-2 gap-4">
            {DEPENDENCIES.map((d) => (
              <DependencyCard
                key={d}
                dep={d}
                stats={data.dependencies[d]}
                server={data.depStats?.stats[d]}
                knobs={data.knobs?.knobs[d]}
                budgetMs={data.settings.budgets[d]}
                hedged={data.settings.hedging.enabled && data.settings.hedging.deps.includes(d)}
              />
            ))}
          </div>
          <ClassTable quotes={data.quotes} settings={data.settings} />
        </div>
        <div className="space-y-4">
          <SettingsPanel settings={data.settings} onChange={reload} />
          {data.knobs && <KnobsPanel knobs={data.knobs.knobs} defaults={data.knobs.defaults} onChange={reload} />}
          <PricingActions canPublish={user?.role === 'admin'} onDone={reload} />
        </div>
      </div>
    </div>
  )
}
