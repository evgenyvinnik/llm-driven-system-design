import { useState } from 'react'
import { BoltIcon } from '@/components/icons'
import { ErrorNote } from '@/components/shared/Feedback'
import { api } from '@/services/api'
import type { OpsOverview } from '@/types'

export function BurstControl({ repositories, onFired }: { repositories: OpsOverview['repositories']; onFired: () => void }) {
  const [count, setCount] = useState(20)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [first, second] = repositories

  async function fire() {
    if (!first) return
    setBusy(true)
    setError(null)
    setMessage(null)
    try {
      const res = await api.burst(first.id, count, second?.id, second ? 2 : 0)
      setMessage(`Accepted ${res.accepted} pushes on ${first.fullName}${second ? ` and ${res.otherAccepted} on ${second.fullName}` : ''}. Watch the concurrency and the wait times.`)
      onFired()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The burst failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-3 p-4 text-sm">
      <label className="flex items-center gap-2">
        <span className="label !mb-0">Pushes</span>
        <input type="number" min={1} max={100} className="input w-20" value={count} onChange={(e) => setCount(Math.max(1, Math.min(100, Number(e.target.value) || 1)))} />
      </label>
      <button type="button" className="btn-primary" disabled={busy || !first} onClick={() => void fire()}>
        <BoltIcon className="h-4 w-4" /> {busy ? 'Firing…' : `Fire a burst at ${first?.fullName ?? '…'}`}
      </button>
      {second && <span className="text-xs text-slate-500">plus 2 pushes at {second.fullName}, which should not wait for the burst</span>}
      {message && <p className="w-full text-xs text-emerald-800">{message}</p>}
      {error && <div className="w-full"><ErrorNote message={error} /></div>}
    </div>
  )
}
