import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ErrorNote, Loading, StatusBadge } from '@/components/shared'
import { useCan, useOrg } from '@/hooks/useOrg'
import { timeAgo } from '@/lib/format'
import { keys } from '@/lib/keys'
import { api } from '@/services/api'

/** Every share link in the org, including revoked ones, so an admin can answer "who shared what, and is it still open?". */
export function LinksTab() {
  const { orgId } = useOrg()
  const canRevoke = useCan('links.manage')
  const qc = useQueryClient()
  const { data, error, isPending } = useQuery({ queryKey: keys.links(orgId), queryFn: ({ signal }) => api.links(orgId, signal) })
  const revoke = useMutation({
    mutationFn: (id: string) => api.revokeLink(orgId, id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.links(orgId) }),
  })
  if (isPending) return <Loading />
  if (error) return <ErrorNote error={error} />
  return (
    <table className="card w-full overflow-hidden">
      <thead className="bg-slate-50">
        <tr><th className="th">Prompt</th><th className="th">Link</th><th className="th">Created by</th><th className="th">Status</th><th className="th">Last opened</th><th className="th" /></tr>
      </thead>
      <tbody className="divide-y divide-slate-100">
        {data.links.map((l) => (
          <tr key={l.id} data-link={l.id}>
            <td className="td font-medium text-slate-900">{l.resourceTitle ?? '(deleted)'}</td>
            <td className="td font-mono text-xs text-slate-500">…{l.tokenHint}</td>
            <td className="td">{l.createdByName ?? 'former member'}</td>
            <td className="td"><StatusBadge status={l.status} /></td>
            <td className="td text-slate-500">{timeAgo(l.lastUsedAt)}</td>
            <td className="td text-right">
              {l.status === 'active' && canRevoke && <button className="btn-danger px-2 py-0.5 text-xs" onClick={() => revoke.mutate(l.id)}>Revoke</button>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
