import { useState } from 'react'
import { useInfiniteQuery } from '@tanstack/react-query'
import { ErrorNote, Loading } from '@/components/shared'
import { useOrg } from '@/hooks/useOrg'
import { dateTime } from '@/lib/format'
import { keys } from '@/lib/keys'
import { api } from '@/services/api'

const ACTIONS = ['', 'member', 'invitation', 'link', 'flag', 'export', 'agent', 'prompt', 'access']

function summarize(value: unknown): string {
  if (value === null || value === undefined) return ''
  return Object.entries(value as Record<string, unknown>)
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') || '—' : typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v)}`)
    .join('; ')
}

export function AuditTab() {
  const { orgId } = useOrg()
  const [action, setAction] = useState('')
  const query = useInfiniteQuery({
    queryKey: keys.audit(orgId, action),
    queryFn: ({ pageParam, signal }) => api.audit(orgId, action, pageParam, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextBefore,
  })
  const events = query.data?.pages.flatMap((p) => p.events) ?? []
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <select className="input w-48" value={action} onChange={(e) => setAction(e.target.value)} aria-label="Filter by action">
          {ACTIONS.map((a) => <option key={a} value={a}>{a ? `${a}.*` : 'All actions'}</option>)}
        </select>
        {query.data && <span className="text-xs text-slate-500">Kept for {query.data.pages[0].retentionDays} days on this plan</span>}
      </div>
      {query.isPending && <Loading />}
      {query.error && <ErrorNote error={query.error} />}
      {query.data && (
        <table className="card w-full overflow-hidden" data-testid="audit-table">
          <thead className="bg-slate-50">
            <tr><th className="th">When</th><th className="th">Actor</th><th className="th">Action</th><th className="th">Target</th><th className="th">Before → after</th></tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {events.map((e) => (
              <tr key={e.id}>
                <td className="td whitespace-nowrap text-xs text-slate-500">{dateTime(e.createdAt)}</td>
                <td className="td">{e.actorName}</td>
                <td className="td font-mono text-xs">{e.action}</td>
                <td className="td">{e.targetName ?? e.targetId ?? '—'}</td>
                <td className="td text-xs text-slate-600">
                  {summarize(e.before) && <span className="text-slate-400 line-through">{summarize(e.before)}</span>}
                  {summarize(e.before) && summarize(e.after) && ' → '}
                  {summarize(e.after)}
                </td>
              </tr>
            ))}
            {events.length === 0 && <tr><td className="td text-slate-500" colSpan={5}>No events.</td></tr>}
          </tbody>
        </table>
      )}
      {query.hasNextPage && (
        <button className="btn-secondary" onClick={() => void query.fetchNextPage()} disabled={query.isFetchingNextPage}>Load older events</button>
      )}
    </div>
  )
}
