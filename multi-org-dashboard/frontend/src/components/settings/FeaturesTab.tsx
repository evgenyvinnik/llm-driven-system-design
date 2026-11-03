import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ErrorNote, Loading } from '@/components/shared'
import { useCan, useOrg } from '@/hooks/useOrg'
import { ROLE_LABEL } from '@/lib/format'
import { keys } from '@/lib/keys'
import { api } from '@/services/api'
import { ROLES, type FeatureFlag, type Role } from '@/types'

function FlagRow({ flag }: { flag: FeatureFlag }) {
  const { orgId } = useOrg()
  const canManage = useCan('features.manage')
  const qc = useQueryClient()
  const [enabled, setEnabled] = useState(flag.rule?.enabled ?? flag.defaultEnabled)
  const [roles, setRoles] = useState<Role[]>(flag.rule?.roles ?? [])
  const save = useMutation({
    mutationFn: () => api.setFeature(orgId, flag.key, { enabled, roles }),
    // The member list of this org gets an authz.changed event; our own manifest refreshes from it too.
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.features(orgId) }),
  })
  const toggle = (r: Role) => setRoles((cur) => (cur.includes(r) ? cur.filter((x) => x !== r) : [...cur, r]))
  return (
    <div className="card space-y-3 p-4" data-flag={flag.key}>
      <div>
        <p className="font-mono text-sm font-semibold">{flag.key}</p>
        <p className="text-sm text-slate-600">{flag.description}</p>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} disabled={!canManage} /> Enabled in this organization
      </label>
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span className="text-slate-500">For roles:</span>
        {ROLES.map((r) => (
          <label key={r} className="flex items-center gap-1.5">
            <input type="checkbox" checked={roles.includes(r)} onChange={() => toggle(r)} disabled={!canManage || !enabled} /> {ROLE_LABEL[r]}
          </label>
        ))}
        <span className="text-xs text-slate-400">(none checked = everyone)</span>
      </div>
      {canManage && <button className="btn-primary" onClick={() => save.mutate()} disabled={save.isPending}>Save</button>}
      {save.isSuccess && <span className="ml-2 text-xs text-emerald-700">Saved. Members see the change within seconds.</span>}
      {save.error && <ErrorNote error={save.error} />}
    </div>
  )
}

export function FeaturesTab() {
  const { orgId } = useOrg()
  const { data, error, isPending } = useQuery({ queryKey: keys.features(orgId), queryFn: ({ signal }) => api.features(orgId, signal) })
  if (isPending) return <Loading />
  if (error) return <ErrorNote error={error} />
  return <div className="space-y-3">{data.flags.map((f) => <FlagRow key={f.key} flag={f} />)}</div>
}
