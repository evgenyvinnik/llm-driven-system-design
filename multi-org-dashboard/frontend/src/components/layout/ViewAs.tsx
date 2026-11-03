import { useState } from 'react'
import { EyeIcon } from '@/components/icons'
import { useOrg } from '@/hooks/useOrg'
import { ROLE_LABEL } from '@/lib/format'
import { keys } from '@/lib/keys'
import { queryClient } from '@/lib/query-client'
import { api } from '@/services/api'
import { ROLES, type Role } from '@/types'

/** Admin-only role preview. The server stores it on the session and refuses every write while it lasts. */
export function ViewAsMenu() {
  const { orgId, manifest } = useOrg()
  const [busy, setBusy] = useState(false)
  if (manifest.actualRole !== 'admin') return null

  const choose = async (role: Role) => {
    setBusy(true)
    try {
      await api.setPreview(orgId, role === 'admin' ? null : role)
      await queryClient.invalidateQueries({ queryKey: keys.org(orgId) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <label className="flex items-center gap-1.5 text-xs text-slate-500">
      <EyeIcon className="h-4 w-4" />
      View as
      <select
        className="rounded-md border border-slate-300 bg-white px-1.5 py-1 text-xs text-slate-700"
        value={manifest.role}
        disabled={busy}
        onChange={(e) => void choose(e.target.value as Role)}
        data-testid="view-as"
      >
        {ROLES.map((r) => (
          <option key={r} value={r}>
            {ROLE_LABEL[r]}
          </option>
        ))}
      </select>
    </label>
  )
}

export function PreviewBanner() {
  const { orgId, manifest } = useOrg()
  if (!manifest.readOnly) return null
  const exit = async () => {
    await api.setPreview(orgId, null)
    await queryClient.invalidateQueries({ queryKey: keys.org(orgId) })
  }
  return (
    <div className="flex items-center justify-center gap-3 bg-amber-100 px-4 py-1.5 text-sm text-amber-900" role="status">
      <span>
        Previewing {manifest.org.name} as <strong>{ROLE_LABEL[manifest.role]}</strong>. Read-only: nothing you do here is saved.
      </span>
      <button className="underline" onClick={() => void exit()}>
        Exit preview
      </button>
    </div>
  )
}
