import { Link } from '@tanstack/react-router'
import { ShieldIcon } from '@/components/icons'
import { useOrg } from '@/hooks/useOrg'
import { ROLE_LABEL } from '@/lib/format'
import type { Decision } from '@/lib/modules'
import { useAccess } from '@/stores/access-store'
import { OtherOrgs } from './OtherOrgs'

/** Shown in place of a page the user had open when their access to it was taken away. */
export function AccessChanged({ label, decision }: { label: string; decision: Exclude<Decision, { allowed: true }> }) {
  const { orgId, manifest } = useOrg()
  const change = useAccess((s) => s.lastChange[orgId])
  let cause = `Your access in ${manifest.org.name} changed`
  if (change?.reason === 'role_changed' && change.from && change.to) {
    cause = `Your role in ${manifest.org.name} changed from ${ROLE_LABEL[change.from]} to ${ROLE_LABEL[change.to]}`
  } else if (decision.reason === 'flag' || change?.reason === 'flag_changed') {
    cause = `An admin turned ${label} off for your role`
  }
  const when = change ? ` at ${new Date(change.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''

  return (
    <div className="mx-auto max-w-xl py-16" data-testid="access-changed" role="alert">
      <div className="card border-amber-200 p-6">
        <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-amber-50 text-amber-700">
          <ShieldIcon className="h-5 w-5" />
        </div>
        <h1 className="text-lg font-semibold">{label} is no longer available to you</h1>
        <p className="mt-1 text-sm text-slate-600">
          {cause}
          {when}, so this page was closed. Changes you hadn't saved here were not sent.
        </p>
        <div className="mt-5 flex gap-2">
          <Link to="/orgs/$orgId" params={{ orgId }} className="btn-primary">
            Go to overview
          </Link>
        </div>
        <OtherOrgs currentOrgId={orgId} heading="Your other organizations" />
      </div>
    </div>
  )
}
