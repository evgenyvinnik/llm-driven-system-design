import { createFileRoute } from '@tanstack/react-router'
import { useCallback, useEffect, useState } from 'react'
import { LockIcon } from '@/components/icons'
import { ErrorNote, Loading, SeverityBadge } from '@/components/shared'
import { pct, relativeTime } from '@/lib/format'
import { ApiError, api } from '@/services/api'
import { useAuthStore } from '@/stores/auth-store'
import type { ControlPolicy } from '@/types'

export const Route = createFileRoute('/controls')({ component: ControlsPage })

function ControlsPage() {
  const user = useAuthStore((s) => s.user)!
  const [controls, setControls] = useState<ControlPolicy[] | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const load = useCallback(() => api.controls().then((r) => setControls(r.controls), setError), [])

  useEffect(() => {
    void load()
  }, [load])

  async function change(c: ControlPolicy, effect: string) {
    setError(null)
    setNotice(null)
    try {
      await api.setPolicy(c.id, effect)
    } catch (err) {
      if (err instanceof ApiError && err.code === 'BURN_DOWN_INCOMPLETE') {
        if (!window.confirm(`${err.message}\n\nForce it anyway?`)) return setNotice(err.message)
        await api.setPolicy(c.id, effect, true).catch(setError)
      } else return setError(err)
    }
    void load()
  }

  if (!controls) return error ? <ErrorNote error={error} /> : <Loading />
  return (
    <div className="space-y-4">
      <div>
        <h1 className="page-title">Controls &amp; prevention</h1>
        <p className="text-sm text-slate-500">
          Detect and remediate first; prevent once burned down. A deny assignment rejects every create or update that leaves the setting insecure, including a team's routine redeploy of an old template and our own rollbacks, so it is
          only offered without force once a control is at least {controls[0]?.denyReadyPct}% compliant. Additive controls can be enforced on creation (deployIfNotExists) at any time.
        </p>
      </div>
      {notice && <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">{notice}</div>}
      <ErrorNote error={error} />
      <div className="grid gap-3 lg:grid-cols-2">
        {controls.map((c) => (
          <div key={c.id} className="card p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-sm font-semibold text-slate-900"><span className="font-mono text-xs text-slate-500">{c.id} v{c.version}</span> {c.title}</div>
                <p className="mt-0.5 text-xs text-slate-500">{c.description}</p>
              </div>
              <SeverityBadge severity={c.severity} />
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-600">
              <span>Compliance <span className="font-semibold text-slate-900">{pct(c.compliancePct)}</span> · {c.open} open</span>
              <span className="text-slate-400">Policy: {c.policyDefinition}</span>
            </div>
            <div className="mt-3 flex items-center gap-2">
              <LockIcon className="h-4 w-4 text-slate-400" />
              <span className="text-xs text-slate-500">Effect</span>
              <div className="flex gap-1">
                {c.allowedEffects.map((e) => (
                  <button key={e} type="button" disabled={user.role !== 'security' || e === c.policyEffect} className={e === c.policyEffect ? 'btn-primary px-2 py-1 text-xs disabled:opacity-100' : 'btn-secondary px-2 py-1 text-xs'} onClick={() => void change(c, e)}>{e}</button>
                ))}
              </div>
              {c.policyUpdatedAt && <span className="text-[11px] text-slate-400">changed {relativeTime(c.policyUpdatedAt)} by {c.policyUpdatedBy}</span>}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
