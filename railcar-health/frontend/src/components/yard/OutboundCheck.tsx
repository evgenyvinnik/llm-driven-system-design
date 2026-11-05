/**
 * What the yard's train-building system asks before adding cars to an outbound
 * train: any car with an active hold or bad order is blocked.
 */
import { useState } from 'react'
import { api } from '@/services/api'

export function OutboundCheck({ yardId, suggestion }: { yardId: string; suggestion: string }) {
  const [text, setText] = useState(suggestion)
  const [result, setResult] = useState<Awaited<ReturnType<typeof api.outboundCheck>> | null>(null)
  const [error, setError] = useState<string | null>(null)
  async function check() {
    setError(null)
    try {
      setResult(await api.outboundCheck(yardId, text.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean)))
    } catch (err) {
      setError((err as Error).message)
    }
  }
  return (
    <div className="space-y-2">
      <p className="text-xs text-slate-500">Paste the car list for an outbound train (one per line). Held cars are refused.</p>
      <textarea className="input font-mono" rows={4} value={text} onChange={(e) => setText(e.target.value)} aria-label="Outbound car list" />
      <button type="button" className="btn-secondary" onClick={() => void check()}>Check outbound list</button>
      {error && <p className="text-sm text-red-600">{error}</p>}
      {result && (
        <div className="space-y-1 text-sm">
          {result.blocked.map((b) => (
            <p key={b.carId} className="rounded bg-red-50 px-2 py-1 text-red-800"><span className="font-mono font-semibold">{b.carId}</span> blocked: {b.status === 'bad_ordered' ? 'bad-ordered' : 'held'} — {b.reason}</p>
          ))}
          {result.clear.length > 0 && <p className="rounded bg-emerald-50 px-2 py-1 text-emerald-800">Clear: <span className="font-mono">{result.clear.join(', ')}</span></p>}
        </div>
      )}
    </div>
  )
}
