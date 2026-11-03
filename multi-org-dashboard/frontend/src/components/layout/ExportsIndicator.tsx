import { Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { DownloadIcon } from '@/components/icons'
import { useOrg } from '@/hooks/useOrg'
import { keys } from '@/lib/keys'
import { decide } from '@/lib/modules'
import { api } from '@/services/api'

/** Running exports for this org; progress arrives over the event stream and patches the same cache entry. */
export function ExportsIndicator() {
  const { orgId, manifest } = useOrg()
  const allowed = decide(manifest, { permission: 'conversations.export', entitlement: 'exports' }).allowed
  const { data } = useQuery({
    queryKey: keys.exports(orgId),
    queryFn: ({ signal }) => api.exports(orgId, signal),
    enabled: allowed,
  })
  const active = (data?.exports ?? []).filter((e) => e.status === 'queued' || e.status === 'running')
  if (!allowed || active.length === 0) return null
  const job = active[0]
  const pct = job.totalRows ? Math.round((job.processedRows / job.totalRows) * 100) : 0
  return (
    <Link to="/orgs/$orgId/exports" params={{ orgId }} className="flex items-center gap-2 text-xs text-slate-600" data-testid="exports-indicator">
      <DownloadIcon className="h-4 w-4 text-brand-600" />
      Exporting… {pct}%
      <span className="h-1.5 w-20 overflow-hidden rounded-full bg-slate-200">
        <span className="block h-full bg-brand-600 transition-all" style={{ width: `${pct}%` }} />
      </span>
    </Link>
  )
}
