import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { ModuleGate } from '@/components/access'
import { CheckIcon, LockIcon } from '@/components/icons'
import { ErrorNote, Loading, PageHeader, StatusBadge } from '@/components/shared'
import { useOrg } from '@/hooks/useOrg'
import { money, number } from '@/lib/format'
import { keys } from '@/lib/keys'
import { api } from '@/services/api'

export const Route = createFileRoute('/orgs/$orgId/billing')({
  component: () => (
    <ModuleGate module="billing">
      <BillingPage />
    </ModuleGate>
  ),
})

function Entitlement({ on, label }: { on: boolean; label: string }) {
  return (
    <li className="flex items-center gap-2 text-sm">
      {on ? <CheckIcon className="h-4 w-4 text-emerald-600" /> : <LockIcon className="h-4 w-4 text-slate-400" />}
      <span className={on ? '' : 'text-slate-500'}>{label}</span>
    </li>
  )
}

function BillingPage() {
  const { orgId } = useOrg()
  const { data, error, isPending } = useQuery({ queryKey: keys.billing(orgId), queryFn: ({ signal }) => api.billing(orgId, signal) })
  return (
    <div className="max-w-4xl">
      <PageHeader title="Billing" description="What this organization's plan includes. Plan entitlements are separate from roles." />
      {isPending && <Loading />}
      {error && <ErrorNote error={error} />}
      {data && (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div className="card p-4">
            <p className="label">Plan</p>
            <p className="text-2xl font-semibold capitalize">{data.plan}</p>
            <ul className="mt-3 space-y-1.5">
              <Entitlement on={data.entitlements.exports} label="Conversation exports" />
              <Entitlement on={data.entitlements.costAnalytics} label="Cost analytics" />
              <Entitlement on label={`${data.entitlements.seats} seats`} />
              <Entitlement on label={`Audit log kept ${data.entitlements.auditRetentionDays} days`} />
            </ul>
            {data.plan === 'starter' && <button className="btn-primary mt-4" disabled title="Billing changes are out of scope in this demo">Upgrade to Pro</button>}
          </div>
          <div className="card p-4">
            <p className="label">This month</p>
            <p className="text-sm">Seats used: <strong>{data.seats.used}</strong> of {data.seats.limit} ({data.seats.members} members, rest pending invitations)</p>
            <p className="mt-1 text-sm">Conversations: <strong>{number(data.usage.conversationsMonthToDate)}</strong></p>
            <p className="mt-1 text-sm">Model cost: <strong>{money(data.usage.costMonthToDateCents)}</strong></p>
          </div>
          <div className="card md:col-span-2">
            <table className="w-full">
              <thead className="bg-slate-50"><tr><th className="th">Invoice</th><th className="th">Period</th><th className="th">Amount</th><th className="th">Status</th></tr></thead>
              <tbody className="divide-y divide-slate-100">
                {data.invoices.map((i) => (
                  <tr key={i.id}><td className="td font-mono text-xs">{i.id}</td><td className="td">{i.period}</td><td className="td">{money(i.amountCents)}</td><td className="td"><StatusBadge status={i.status} /></td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
