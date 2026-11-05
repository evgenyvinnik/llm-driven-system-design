import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useCallback, useEffect, useState } from 'react'
import { ConfigTable } from '@/components/account/ConfigTable'
import { EvidencePanel } from '@/components/account/EvidencePanel'
import { ExceptionForm } from '@/components/account/ExceptionForm'
import { HistoryList } from '@/components/account/HistoryList'
import { ErrorNote, Loading, StateBadge } from '@/components/shared'
import { newIdempotencyKey, relativeTime } from '@/lib/format'
import { api } from '@/services/api'
import { useAuthStore } from '@/stores/auth-store'
import type { AccountDetail } from '@/types'

export const Route = createFileRoute('/accounts/$name')({ component: AccountPage })

function AccountPage() {
  const { name } = Route.useParams()
  const user = useAuthStore((s) => s.user)!
  const navigate = useNavigate()
  const [data, setData] = useState<AccountDetail | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [exceptionFor, setExceptionFor] = useState<string | null>(null)
  const load = useCallback(() => api.account(name).then(setData, setError), [name])

  useEffect(() => {
    void load()
  }, [load])

  async function fix(controlId: string) {
    setBusy(controlId)
    try {
      const { campaignId } = await api.fixNow(name, controlId, newIdempotencyKey('fix'))
      void navigate({ to: '/campaigns/$campaignId', params: { campaignId } })
    } catch (err) {
      setError(err)
      setBusy(null)
    }
  }

  if (error && !data) return <ErrorNote error={error} />
  if (!data) return <Loading />
  const a = data.account
  const exceptionControl = data.controls.find((c) => c.controlId === exceptionFor)

  return (
    <div className="space-y-4">
      <div>
        <Link to="/findings" className="text-xs text-accent-700 hover:underline">← Findings</Link>
        <h1 className="page-title font-mono">{a.name}</h1>
        <p className="text-sm text-slate-500">
          {a.subscriptionName} ({a.managementGroup}) · {a.resourceGroup} · {a.location} · {a.environment} · {a.dataClassification ?? 'unclassified'} · owner{' '}
          {a.owner ?? 'none'}
          {a.ownerSource === 'subscription' ? ' (from subscription: owner tag missing)' : ''}
        </p>
        <p className="text-xs text-slate-400">
          Last observed {relativeTime(a.observedAt)} via {a.observedVia === 'graph' ? 'Resource Graph (full scan)' : 'ARM read after a change event'} · resource modified {relativeTime(a.propertiesModifiedAt)} · ~{a.trafficPerMin} requests/min
        </p>
      </div>
      <ErrorNote error={error} />
      <ConfigTable controls={data.controls} canAct={user.role !== 'approver'} busy={busy} onFix={(c) => void fix(c)} onRequestException={setExceptionFor} />
      {exceptionControl?.finding && (
        <ExceptionForm accountName={a.name} controlId={exceptionControl.controlId} severity={exceptionControl.finding.severity} onCancel={() => setExceptionFor(null)} onDone={() => { setExceptionFor(null); void load() }} />
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        <EvidencePanel evidence={data.evidence} />
        <div className="space-y-4">
          {data.targets.length > 0 && (
            <div className="card p-4">
              <h2 className="text-sm font-semibold text-slate-800">Remediation attempts</h2>
              <ul className="mt-2 space-y-1.5 text-sm">
                {data.targets.map((t) => (
                  <li key={t.id} className="flex flex-wrap items-center gap-2">
                    <StateBadge state={t.state} />
                    <Link to="/campaigns/$campaignId" params={{ campaignId: t.campaignId }} className="text-accent-700 hover:underline">{t.campaignName}</Link>
                    {t.rollbackReason && <span className="text-xs text-orange-800">{t.rollbackReason}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <HistoryList entries={data.history} />
        </div>
      </div>
    </div>
  )
}
