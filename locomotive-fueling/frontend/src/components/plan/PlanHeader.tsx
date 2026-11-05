import { useState } from 'react'
import { CheckIcon, InfoIcon, RefreshIcon, ShieldIcon } from '@/components/icons'
import { Chip, ConfidenceChip, LifecycleChip, SourceChip } from '@/components/shared/Chips'
import { simTime } from '@/lib/format'
import { api } from '@/services/api'
import type { Plan, Role } from '@/types'

export function PlanHeader({ trainId, plan, role, canAccept, onChanged }: { trainId: string; plan: Plan; role: Role; canAccept: boolean; onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const run = async (what: string, fn: () => Promise<unknown>) => {
    setBusy(what)
    setMessage(null)
    try {
      await fn()
      onChanged()
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Failed')
    } finally {
      setBusy(null)
    }
  }
  return (
    <div className="card p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-base font-semibold text-slate-900">Fuel plan v{plan.version}</h2>
        <LifecycleChip lifecycle={plan.lifecycle} />
        <SourceChip source={plan.source} />
        <ConfidenceChip confidence={plan.confidence} />
        {plan.status !== 'ok' && <Chip kind="bad">{plan.status === 'emergency' ? 'Emergency: uses reserve' : 'No feasible plan'}</Chip>}
        <div className="flex-1" />
        {plan.lifecycle === 'recommended' && canAccept && (
          <button type="button" className="btn-primary" disabled={busy !== null} onClick={() => void run('accept', () => api.acceptPlan(trainId, plan.version))}>
            <CheckIcon className="h-4 w-4" /> {busy === 'accept' ? 'Accepting…' : 'Accept plan'}
          </button>
        )}
        {role !== 'crew' && (
          <button type="button" className="btn-secondary" disabled={busy !== null} onClick={() => void run('replan', () => api.replan(trainId))}>
            <RefreshIcon className="h-4 w-4" /> Re-plan now
          </button>
        )}
      </div>
      <p className="mt-2 text-sm text-slate-700">{plan.reason}</p>
      <p className="mt-1 text-xs text-slate-500">
        Created {simTime(plan.createdAt)} at MP {Math.round(plan.milepost)}
        {plan.lifecycle === 'accepted' && plan.acceptedBy ? ` · accepted by ${plan.acceptedBy} at ${simTime(plan.acceptedAt)}` : ''}
        {plan.lifecycle === 'recommended' ? ' · a recommendation reserves nothing until it is accepted' : ''}
      </p>
      {message && <p className="mt-2 text-sm text-red-700">{message}</p>}
      <details className="mt-3 rounded-md bg-slate-50 px-3 py-2 text-sm" open={plan.confidence !== 'high'}>
        <summary className="flex cursor-pointer items-center gap-1.5 font-medium text-slate-700">
          <ShieldIcon className="h-4 w-4" /> Assumptions and safety margin
        </summary>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-slate-600">
          {plan.assumptions.map((a) => (
            <li key={a}>{a}</li>
          ))}
          {(plan.inputs.unavailable ?? []).map((u) => (
            <li key={u}>Not usable: {u}</li>
          ))}
          {(plan.inputs.queues ?? []).map((q) => (
            <li key={q}>Queue: {q}</li>
          ))}
        </ul>
        <p className="mt-2 flex items-center gap-1 text-xs text-slate-500">
          <InfoIcon className="h-3.5 w-3.5" /> Every unit must stay above its reserve at every station under the margin above. Fuel left at the destination is credited below its posted price.
        </p>
      </details>
    </div>
  )
}
