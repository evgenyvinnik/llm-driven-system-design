import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import { LockIcon } from '@/components/icons'
import { useOrg } from '@/hooks/useOrg'
import { ROLE_LABEL } from '@/lib/format'
import type { Decision } from '@/lib/modules'
import { api } from '@/services/api'
import { OtherOrgs } from './OtherOrgs'

/** A 403 page: says why, and offers the two ways forward (another org, or asking for access). */
export function Forbidden({ label, decision }: { label: string; decision: Exclude<Decision, { allowed: true }> }) {
  const { orgId, manifest } = useOrg()
  const [requested, setRequested] = useState<'idle' | 'sending' | 'sent' | 'failed'>('idle')
  const role = ROLE_LABEL[manifest.role]

  const request = async () => {
    setRequested('sending')
    try {
      await api.requestAccess(orgId, {
        permission: decision.reason === 'permission' ? decision.permission : undefined,
        page: label,
      })
      setRequested('sent')
    } catch {
      setRequested('failed')
    }
  }

  let title = `You don't have access to ${label}`
  let body = `Your role in ${manifest.org.name} is ${role}, which doesn't include ${label.toLowerCase()}.`
  if (decision.reason === 'entitlement') {
    title = `${label} is part of the Pro plan`
    body = `${manifest.org.name} is on the ${manifest.org.plan} plan. An admin can upgrade it from Billing.`
  } else if (decision.reason === 'flag') {
    title = `${label} isn't turned on here`
    body = `${label} is in beta and isn't enabled for your role in ${manifest.org.name}.`
  }

  return (
    <div className="mx-auto max-w-xl py-16" data-testid="forbidden">
      <div className="card p-6">
        <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-slate-100 text-slate-500">
          <LockIcon className="h-5 w-5" />
        </div>
        <h1 className="text-lg font-semibold">{title}</h1>
        <p className="mt-1 text-sm text-slate-600">{body}</p>
        <div className="mt-5 flex flex-wrap gap-2">
          {decision.reason !== 'entitlement' && (
            <button className="btn-primary" onClick={request} disabled={requested === 'sending' || requested === 'sent' || manifest.readOnly}>
              {requested === 'sent' ? 'Request sent to admins' : 'Request access'}
            </button>
          )}
          {decision.reason === 'entitlement' && manifest.permissions.includes('billing.read') && (
            <Link to="/orgs/$orgId/billing" params={{ orgId }} className="btn-primary">
              View plans
            </Link>
          )}
          <Link to="/orgs/$orgId" params={{ orgId }} className="btn-secondary">
            Go to overview
          </Link>
        </div>
        {requested === 'failed' && <p className="mt-2 text-sm text-red-700">Couldn't send the request. Try again.</p>}
        <OtherOrgs currentOrgId={orgId} heading="Or switch to another organization" />
      </div>
    </div>
  )
}
