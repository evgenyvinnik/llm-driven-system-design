import { useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { CheckIcon, ChevronDownIcon } from '@/components/icons'
import { RoleBadge } from '@/components/shared'
import { useOrg } from '@/hooks/useOrg'
import { brandSwatch } from '@/lib/branding'
import { MODULE_ROUTES, moduleFromPath } from '@/lib/modules'
import { useAuth } from '@/stores/auth-store'

/**
 * Switching is a navigation to /orgs/<other id>. The org route's beforeLoad
 * aborts the old org's requests; the new org's pages load into their own
 * cache entries. The current module is kept when the new role allows it,
 * otherwise the guard explains.
 */
export function OrgSwitcher() {
  const { orgId, manifest } = useOrg()
  const orgs = useAuth((s) => s.orgs)
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)

  const go = (id: string) => {
    setOpen(false)
    if (id === orgId) return
    // Keep the module, drop resource ids and filters: they belong to the old org.
    void navigate({ to: MODULE_ROUTES[moduleFromPath(window.location.pathname)], params: { orgId: id } })
  }

  return (
    <div className="relative">
      <button
        className="flex items-center gap-2 rounded-md px-2 py-1 text-sm font-medium hover:bg-slate-100"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        data-testid="org-switcher"
      >
        <span className="flex h-7 w-7 items-center justify-center rounded-md bg-brand-600 text-xs font-bold text-white">
          {manifest.org.branding.initials}
        </span>
        {manifest.org.name}
        <ChevronDownIcon className="h-4 w-4 text-slate-400" />
      </button>
      {open && (
        <ul role="listbox" className="absolute left-0 z-30 mt-1 w-72 rounded-lg border border-slate-200 bg-white p-1 shadow-lg">
          {orgs.map((org) => (
            <li key={org.id}>
              <button
                role="option"
                aria-selected={org.id === orgId}
                onClick={() => go(org.id)}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-slate-50"
                data-org={org.id}
              >
                <span className="flex h-6 w-6 items-center justify-center rounded text-[10px] font-bold text-white" style={{ background: brandSwatch(org.branding.accent) }}>
                  {org.branding.initials}
                </span>
                <span className="flex-1">{org.name}</span>
                <RoleBadge role={org.role} />
                {org.id === orgId && <CheckIcon className="h-4 w-4 text-brand-600" />}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
