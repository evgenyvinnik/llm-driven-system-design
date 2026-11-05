import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { AuditTable } from '@/components/audit/AuditTable'
import { ErrorNote, Loading } from '@/components/shared'
import { api } from '@/services/api'
import type { AuditEntry } from '@/types'

export const Route = createFileRoute('/audit')({
  validateSearch: (search: Record<string, unknown>): { action?: string; account?: string } => ({
    action: typeof search.action === 'string' ? search.action : undefined,
    account: typeof search.account === 'string' ? search.account : undefined,
  }),
  component: AuditPage,
})

const ACTIONS = ['', 'remediation.applied', 'remediation.rolled_back', 'remediation.', 'campaign.', 'exception.', 'policy.', 'finding.reopened']

function AuditPage() {
  const search = Route.useSearch()
  const [action, setAction] = useState(search.action ?? '')
  const [account, setAccount] = useState(search.account ?? '')
  const [entries, setEntries] = useState<AuditEntry[] | null>(null)
  const [next, setNext] = useState<number | null>(null)
  const [error, setError] = useState<unknown>(null)

  useEffect(() => {
    const timer = setTimeout(() => api.audit({ action: action || undefined, account: account || undefined }).then((r) => { setEntries(r.entries); setNext(r.nextBefore) }, setError), 250)
    return () => clearTimeout(timer)
  }, [action, account])

  const more = () => next && api.audit({ action: action || undefined, account: account || undefined, before: next }).then((r) => { setEntries((e) => [...(e ?? []), ...r.entries]); setNext(r.nextBefore) }, setError)

  return (
    <div className="space-y-4">
      <div>
        <h1 className="page-title">Audit log</h1>
        <p className="text-sm text-slate-500">Append-only: every change with who, what, when, and the value before and after. The database rejects updates and deletes on this table.</p>
      </div>
      <div className="card flex flex-wrap items-end gap-3 p-3">
        <label className="block w-56">
          <span className="label">Action</span>
          <select className="input" value={action} onChange={(e) => setAction(e.target.value)}>
            {ACTIONS.map((a) => <option key={a} value={a}>{a || 'All actions'}</option>)}
          </select>
        </label>
        <label className="block w-64">
          <span className="label">Account name</span>
          <input className="input" value={account} onChange={(e) => setAccount(e.target.value)} placeholder="exact account name" />
        </label>
      </div>
      <ErrorNote error={error} />
      {entries ? <AuditTable entries={entries} /> : <Loading />}
      {next && <button type="button" className="btn-secondary" onClick={() => void more()}>Load older</button>}
    </div>
  )
}
