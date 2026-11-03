import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { CopyLinkRow } from './CopyLinkRow'
import { ErrorNote, RoleBadge } from '@/components/shared'
import { useCan, useOrg } from '@/hooks/useOrg'
import { ROLE_LABEL, timeAgo } from '@/lib/format'
import { keys } from '@/lib/keys'
import { api } from '@/services/api'
import { ROLES, type PromptDetail, type Role } from '@/types'

/**
 * Three ways to share, from narrowest to widest: nobody (private), named
 * roles in this org, or a link anyone can open until it is revoked or expires.
 */
export function SharingControls({ prompt }: { prompt: PromptDetail }) {
  const { orgId } = useOrg()
  const qc = useQueryClient()
  const canShare = useCan('prompts.share') && prompt.isOwner
  const [roles, setRoles] = useState<Role[]>(prompt.sharedRoles)
  const [newLink, setNewLink] = useState<string | null>(null)
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: keys.prompt(orgId, prompt.id) })
    void qc.invalidateQueries({ queryKey: keys.prompts(orgId) })
  }
  const saveRoles = useMutation({ mutationFn: () => api.updatePrompt(orgId, prompt.id, { sharedRoles: roles }), onSuccess: refresh })
  const createLink = useMutation({
    mutationFn: () => api.createLink(orgId, prompt.id, 30),
    onSuccess: ({ link }) => {
      setNewLink(`${window.location.origin}${link.url}`)
      refresh()
    },
  })
  const revoke = useMutation({ mutationFn: (linkId: string) => api.revokeLink(orgId, linkId), onSuccess: refresh })
  const toggle = (role: Role) => setRoles((r) => (r.includes(role) ? r.filter((x) => x !== role) : [...r, role]))
  const changed = [...roles].sort().join() !== [...prompt.sharedRoles].sort().join()

  return (
    <div className="space-y-4">
      <section>
        <p className="label">Shared with roles</p>
        {canShare ? (
          <div className="flex flex-wrap items-center gap-3">
            {ROLES.map((r) => (
              <label key={r} className="flex items-center gap-1.5 text-sm">
                <input type="checkbox" checked={roles.includes(r)} onChange={() => toggle(r)} /> {ROLE_LABEL[r]}
              </label>
            ))}
            <button className="btn-secondary" disabled={!changed || saveRoles.isPending} onClick={() => saveRoles.mutate()}>Save</button>
          </div>
        ) : prompt.sharedRoles.length ? (
          <div className="flex gap-1">{prompt.sharedRoles.map((r) => <RoleBadge key={r} role={r} />)}</div>
        ) : (
          <p className="text-sm text-slate-500">Private to {prompt.ownerName ?? 'its owner'}.</p>
        )}
      </section>
      {(prompt.isOwner || prompt.links.length > 0) && (
        <section>
          <div className="mb-1 flex items-center justify-between">
            <p className="label mb-0">Links</p>
            {canShare && <button className="btn-secondary" onClick={() => createLink.mutate()} disabled={createLink.isPending}>Create link</button>}
          </div>
          {newLink && <CopyLinkRow url={newLink} />}
          <ul className="divide-y divide-slate-100 text-sm">
            {prompt.links.map((l) => (
              <li key={l.id} className="flex items-center gap-2 py-1.5">
                <span className="font-mono text-xs text-slate-500">…{l.tokenHint}</span>
                <span className="flex-1 text-xs text-slate-500">
                  {l.revokedAt ? `revoked ${timeAgo(l.revokedAt)}` : `created ${timeAgo(l.createdAt)} · last opened ${timeAgo(l.lastUsedAt)}`}
                </span>
                {!l.revokedAt && canShare && <button className="btn-danger px-2 py-0.5 text-xs" onClick={() => revoke.mutate(l.id)}>Revoke</button>}
              </li>
            ))}
            {prompt.links.length === 0 && <li className="py-1.5 text-xs text-slate-500">No links yet.</li>}
          </ul>
        </section>
      )}
      {(saveRoles.error || createLink.error || revoke.error) && <ErrorNote error={saveRoles.error ?? createLink.error ?? revoke.error} />}
    </div>
  )
}
