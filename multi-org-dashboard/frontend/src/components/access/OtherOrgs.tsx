import { Link } from '@tanstack/react-router'
import { RoleBadge } from '@/components/shared'
import { brandSwatch } from '@/lib/branding'
import { useAuth } from '@/stores/auth-store'

export function OtherOrgs({ currentOrgId, heading }: { currentOrgId: string | null; heading: string }) {
  const orgs = useAuth((s) => s.orgs).filter((o) => o.id !== currentOrgId)
  if (orgs.length === 0) return null
  return (
    <div className="mt-6 border-t border-slate-100 pt-4">
      <p className="label">{heading}</p>
      <ul className="space-y-1">
        {orgs.map((org) => (
          <li key={org.id}>
            <Link
              to="/orgs/$orgId"
              params={{ orgId: org.id }}
              className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-slate-50"
            >
              <span className="flex h-6 w-6 items-center justify-center rounded text-[10px] font-bold text-white" style={{ background: brandSwatch(org.branding.accent) }}>
                {org.branding.initials}
              </span>
              <span className="flex-1">{org.name}</span>
              <RoleBadge role={org.role} />
            </Link>
          </li>
        ))}
      </ul>
    </div>
  )
}
