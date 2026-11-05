import { useState } from 'react'
import { CheckIcon, XIcon } from '@/components/icons'
import { gal, money } from '@/lib/format'
import { api } from '@/services/api'
import type { Plan, Proposal } from '@/types'

/** A cheaper plan found after acceptance. Nothing changes until the fuel desk confirms. */
export function ProposalCard({ trainId, proposal, current, milepost, canConfirm, onChanged }: { trainId: string; proposal: Proposal; current: Plan; milepost: number; canConfirm: boolean; onChanged: () => void }) {
  const ahead = current.stops.filter((s) => s.milepost >= milepost - 0.5)
  const buys = (b: Plan['costBreakdown']) => b.fuel + b.fees
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
      onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="card border-amber-300 bg-amber-50/60 p-4" data-testid="proposal">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold text-amber-900">Proposed change: v{proposal.version} would replace accepted v{current.version}</h3>
        <div className="flex-1" />
        {canConfirm && (
          <>
            <button type="button" className="btn-primary" disabled={busy} onClick={() => void act(() => api.confirmProposal(trainId, proposal.version))}>
              <CheckIcon className="h-4 w-4" /> Confirm change
            </button>
            <button type="button" className="btn-secondary" disabled={busy} onClick={() => void act(() => api.rejectProposal(trainId, proposal.version))}>
              <XIcon className="h-4 w-4" /> Keep current
            </button>
          </>
        )}
      </div>
      <p className="mt-1 text-sm text-amber-900">{proposal.reason}</p>
      <div className="mt-2 grid gap-3 text-sm sm:grid-cols-2">
        <div>
          <div className="panel-title">Accepted now</div>
          <div className="text-slate-700">{ahead.map((s) => `${s.name} (${gal(s.gallons)})`).join(' → ') || 'No further stops'}</div>
          <div className="num text-slate-500">Buys {money(ahead.reduce((t, s) => t + s.fuelCost + s.fee, 0))} of fuel ahead</div>
        </div>
        <div>
          <div className="panel-title">Proposed</div>
          <div className="text-slate-700">{proposal.stops.map((s) => `${s.name} (${gal(s.gallons)})`).join(' → ') || 'No stops'}</div>
          <div className="num text-slate-500">
            Buys {money(buys(proposal.costBreakdown))} · net of destination credit {money(proposal.costTotal)}
          </div>
        </div>
      </div>
      <p className="mt-2 text-xs text-amber-800">Confirming releases the current reservations and cancels any truck ordered for a dropped stop (the vendor may charge a cancellation fee).</p>
      {error && <p className="mt-1 text-sm text-red-700">{error}</p>}
    </div>
  )
}
