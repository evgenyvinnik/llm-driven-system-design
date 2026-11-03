import { useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CopyLinkRow } from '@/components/prompts/CopyLinkRow'
import { ErrorNote, Loading, RoleBadge, StatusBadge } from '@/components/shared'
import { useCan, useOrg } from '@/hooks/useOrg'
import { ROLE_LABEL, timeAgo } from '@/lib/format'
import { keys } from '@/lib/keys'
import { api } from '@/services/api'
import { ROLES, type Role } from '@/types'

export function InvitationsTab() {
  const { orgId } = useOrg()
  const canManage = useCan('members.manage')
  const qc = useQueryClient()
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<Role>('viewer')
  const [acceptUrl, setAcceptUrl] = useState<string | null>(null)
  const { data, error, isPending } = useQuery({ queryKey: keys.invitations(orgId), queryFn: ({ signal }) => api.invitations(orgId, signal) })
  const refresh = () => void qc.invalidateQueries({ queryKey: keys.invitations(orgId) })
  const invite = useMutation({
    mutationFn: () => api.invite(orgId, email, role),
    onSuccess: ({ invitation }) => {
      setAcceptUrl(`${window.location.origin}${invitation.acceptUrl}`)
      setEmail('')
      refresh()
    },
  })
  const revoke = useMutation({ mutationFn: (id: string) => api.revokeInvitation(orgId, id), onSuccess: refresh })
  const submit = (e: FormEvent) => {
    e.preventDefault()
    invite.mutate()
  }

  return (
    <div className="space-y-4">
      {canManage && (
        <form onSubmit={submit} className="card flex flex-wrap items-end gap-2 p-4">
          <div className="min-w-64 flex-1">
            <label className="label" htmlFor="invite-email">Email</label>
            <input id="invite-email" type="email" className="input" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </div>
          <div>
            <label className="label" htmlFor="invite-role">Role</label>
            <select id="invite-role" className="input" value={role} onChange={(e) => setRole(e.target.value as Role)}>
              {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
            </select>
          </div>
          <button className="btn-primary" disabled={invite.isPending}>Send invitation</button>
        </form>
      )}
      {acceptUrl && <CopyLinkRow url={acceptUrl} />}
      {invite.error && <ErrorNote error={invite.error} />}
      {isPending && <Loading />}
      {error && <ErrorNote error={error} />}
      {data && (
        <table className="card w-full overflow-hidden">
          <thead className="bg-slate-50">
            <tr><th className="th">Email</th><th className="th">Role</th><th className="th">Status</th><th className="th">Invited by</th><th className="th">Expires</th><th className="th" /></tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {data.invitations.map((i) => (
              <tr key={i.id}>
                <td className="td">{i.email}</td>
                <td className="td"><RoleBadge role={i.role} /></td>
                <td className="td"><StatusBadge status={i.status} /></td>
                <td className="td text-slate-500">{i.invitedByName ?? 'former member'}</td>
                <td className="td text-slate-500">{i.status === 'pending' ? new Date(i.expiresAt).toLocaleDateString() : timeAgo(i.createdAt)}</td>
                <td className="td text-right">
                  {i.status === 'pending' && canManage && <button className="btn-danger px-2 py-0.5 text-xs" onClick={() => revoke.mutate(i.id)}>Revoke</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
