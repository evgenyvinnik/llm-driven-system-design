import { BuildingIcon } from '@/components/icons'
import { useAccess } from '@/stores/access-store'
import { OtherOrgs } from './OtherOrgs'

/**
 * The org-level 404, and the page shown when the user is removed from the
 * org they're looking at. The 404 text doesn't say whether the org exists.
 */
export function OrgUnavailable({ orgId }: { orgId: string }) {
  const revoked = useAccess((s) => s.revoked[orgId])
  return (
    <div className="mx-auto max-w-xl px-4 py-20" data-testid={revoked ? 'org-revoked' : 'org-not-found'} role="alert">
      <div className="card p-6">
        <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-slate-100 text-slate-500">
          <BuildingIcon className="h-5 w-5" />
        </div>
        {revoked ? (
          <>
            <h1 className="text-lg font-semibold">You no longer have access to {revoked.orgName}</h1>
            <p className="mt-1 text-sm text-slate-600">
              An admin removed you from this organization. Its data has been cleared from this tab, and links you shared from it
              no longer work.
            </p>
          </>
        ) : (
          <>
            <h1 className="text-lg font-semibold">Organization not found</h1>
            <p className="mt-1 text-sm text-slate-600">
              This organization doesn't exist, or your account isn't a member of it. Check the link, or ask an admin there to invite
              you.
            </p>
          </>
        )}
        <OtherOrgs currentOrgId={orgId} heading="Switch to one of your organizations" />
      </div>
    </div>
  )
}
