import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { AlertIcon, DatabaseIcon, GaugeIcon, RefreshIcon, UndoIcon } from '@/components/icons'
import { BurnDownChart } from '@/components/posture/BurnDownChart'
import { ControlTable } from '@/components/posture/ControlTable'
import { FreshnessBanner } from '@/components/posture/FreshnessBanner'
import { ErrorNote, Loading, StatTile } from '@/components/shared'
import { num, pct } from '@/lib/format'
import { api } from '@/services/api'
import { useAuthStore } from '@/stores/auth-store'
import type { Posture } from '@/types'

export const Route = createFileRoute('/posture')({ component: PosturePage })

function PosturePage() {
  const user = useAuthStore((s) => s.user)!
  const [data, setData] = useState<Posture | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [scanRequested, setScanRequested] = useState(false)

  useEffect(() => {
    const load = () => api.posture().then(setData, setError)
    void load()
    const timer = setInterval(load, 15_000)
    return () => clearInterval(timer)
  }, [])

  if (error && !data) return <ErrorNote error={error} />
  if (!data) return <Loading />
  const scope = data.scope.kind === 'team' ? `Accounts owned by ${data.scope.team}` : `${num(data.fleet.accounts)} storage accounts in ${num(data.fleet.subscriptions)} subscriptions`

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="page-title">Security posture</h1>
          <p className="text-sm text-slate-500">{scope}</p>
        </div>
        {user.role === 'security' && (
          <button type="button" className="btn-secondary" disabled={scanRequested} onClick={() => api.requestScan('full-scan').then(() => setScanRequested(true))}>
            <RefreshIcon /> {scanRequested ? 'Full scan requested' : 'Run full scan now'}
          </button>
        )}
      </div>
      <FreshnessBanner freshness={data.freshness} />
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatTile label="Checks passing" value={pct(data.fleet.compliancePct)} hint="accounts × controls evaluated" icon={<GaugeIcon />} />
        <StatTile label="Open findings" value={num(data.fleet.openFindings)} hint="across 7 controls" icon={<DatabaseIcon />} />
        <StatTile label="Critical open" value={num(data.fleet.criticalOpen)} hint="public access on confidential data" icon={<AlertIcon />} />
        <StatTile label="Exempt" value={num(data.fleet.exempt)} hint="approved, time-boxed exceptions" icon={<UndoIcon />} />
      </div>
      <div className="card p-4">
        <div className="mb-2 flex items-baseline justify-between">
          <h2 className="text-sm font-semibold text-slate-800">Open findings (burn-down)</h2>
          <span className="text-xs text-slate-400">fleet-wide · hover for values</span>
        </div>
        <BurnDownChart points={data.history} />
      </div>
      <ControlTable controls={data.controls} history={data.history} />
      <p className="text-xs text-slate-500">
        Definitions: compliance = accounts passing the control ÷ accounts evaluated for it. Exempt accounts do not count as compliant. An account is evaluated once the resource the control reads (account,
        blob service or diagnostic setting) has been read at least once.
      </p>
    </div>
  )
}
