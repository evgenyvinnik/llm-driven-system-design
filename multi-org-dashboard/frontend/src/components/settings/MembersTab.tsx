import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ErrorNote, Loading, RoleBadge } from '@/components/shared'
import { useCan, useOrg } from '@/hooks/useOrg'
import { ROLE_LABEL, timeAgo } from '@/lib/format'
import { keys } from '@/lib/keys'
import { api } from '@/services/api'
import { useToasts } from '@/stores/toast-store'
import { ROLES, type Member, type Role } from '@/types'

export function MembersTab() {
  const { orgId, manifest } = useOrg()
  const canManage = useCan('members.manage')
  const qc = useQueryClient()
  const toast = useToasts((s) => s.push)
  const { data, error, isPending } = useQuery({ queryKey: keys.members(orgId), queryFn: ({ signal }) => api.members(orgId, signal) })
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: keys.members(orgId) })
    void qc.invalidateQueries({ queryKey: keys.links(orgId) })
    void qc.invalidateQueries({ queryKey: keys.invitations(orgId) })
  }
  const onError = (err: unknown) => toast({ tone: 'error', title: 'Change not saved', body: (err as Error).message })
  const changeRole = useMutation({
    mutationFn: ({ id, role }: { id: string; role: Role }) => api.changeRole(orgId, id, role),
    onSuccess: refresh,
    onError,
  })
  const remove = useMutation({
    mutationFn: (m: Member) => api.removeMember(orgId, m.id),
    onSuccess: (r, m) => {
      refresh()
      toast({
        tone: 'success',
        title: `${m.displayName} was removed`,
        body: `${r.linksRevoked} link(s) and ${r.invitationsRevoked} invitation(s) revoked, ${r.exportsCancelled} export(s) cancelled.`,
      })
    },
    onError,
  })
  const confirmRemove = (m: Member) => {
    const ok = window.confirm(
      `Remove ${m.displayName} from ${manifest.org.name}?\n\nTheir open pages close, share links they created stop working, ` +
        'invitations they sent are revoked and their running exports are cancelled.',
    )
    if (ok) remove.mutate(m)
  }

  if (isPending) return <Loading />
  if (error) return <ErrorNote error={error} />
  return (
    <table className="card w-full overflow-hidden">
      <thead className="bg-slate-50">
        <tr><th className="th">Name</th><th className="th">Email</th><th className="th">Role</th><th className="th">Joined</th><th className="th" /></tr>
      </thead>
      <tbody className="divide-y divide-slate-100">
        {data.members.map((m) => (
          <tr key={m.id} data-member={m.displayName}>
            <td className="td font-medium text-slate-900">{m.displayName}{m.isYou && <span className="ml-1 text-xs text-slate-400">(you)</span>}</td>
            <td className="td text-slate-500">{m.email ?? '—'}</td>
            <td className="td">
              {canManage ? (
                <select
                  aria-label={`Role of ${m.displayName}`}
                  className="rounded border border-slate-200 bg-white px-1.5 py-0.5 text-xs"
                  value={m.role}
                  onChange={(e) => changeRole.mutate({ id: m.id, role: e.target.value as Role })}
                >
                  {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                </select>
              ) : (
                <RoleBadge role={m.role} />
              )}
            </td>
            <td className="td text-slate-500">{timeAgo(m.joinedAt)}</td>
            <td className="td text-right">
              {canManage && !m.isYou && <button className="btn-danger px-2 py-0.5 text-xs" onClick={() => confirmRemove(m)}>Remove</button>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
