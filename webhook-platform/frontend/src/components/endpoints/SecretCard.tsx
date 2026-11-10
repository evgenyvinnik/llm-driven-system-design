import { useState } from 'react'
import { CopyIcon, KeyIcon, RotateKeyIcon } from '@/components/icons'
import { ErrorNote } from '@/components/shared/Loading'
import { until } from '@/lib/format'
import { api } from '@/services/api'
import type { Endpoint } from '@/types'

/** Signing secret: reveal, and rotate with an overlap window during which both secrets sign. */
export function SecretCard({ endpoint: e, onRotated }: { endpoint: Endpoint; onRotated: () => void }) {
  const [revealed, setRevealed] = useState<{ current: string; previous: string | null } | null>(null)
  const [overlap, setOverlap] = useState(120)
  const [error, setError] = useState<string | null>(null)

  async function reveal() {
    const s = await api.secret(e.id)
    setRevealed({ current: s.current, previous: s.previous })
  }
  async function rotate() {
    setError(null)
    try {
      await api.rotateSecret(e.id, overlap)
      await reveal()
      onRotated()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Rotation failed')
    }
  }

  return (
    <section className="card space-y-3 p-4">
      <h2 className="panel-title flex items-center gap-1.5"><KeyIcon className="h-3.5 w-3.5" /> Signing secret</h2>
      <div className="text-sm">
        <div className="flex items-center gap-2 font-mono text-xs">
          {revealed ? revealed.current : e.secretHint}
          {revealed && (
            <button type="button" className="btn-ghost px-1 py-0.5" title="Copy" onClick={() => void navigator.clipboard?.writeText(revealed.current)}>
              <CopyIcon className="h-3.5 w-3.5" />
            </button>
          )}
          {!revealed && <button type="button" className="btn-ghost px-1.5 py-0.5 text-xs" onClick={() => void reveal()}>Reveal</button>}
        </div>
        {e.rotation ? (
          <p className="mt-2 rounded-md bg-amber-50 px-2 py-1.5 text-xs text-amber-900">
            Rotation in progress: the previous secret{revealed?.previous ? <> (<span className="font-mono">{revealed.previous.slice(0, 14)}…</span>)</> : null} still signs every
            request for {until(e.rotation.previousExpiresAt)}. Each request carries two <span className="code">v1=</span> signatures until then.
          </p>
        ) : (
          <p className="mt-2 text-xs text-slate-500">Requests carry <span className="code">Webhook-Signature: t=…,v1=…</span>, an HMAC-SHA256 of <span className="code">t.body</span>.</p>
        )}
      </div>
      <div className="flex items-end gap-2">
        <div>
          <label className="label" htmlFor="overlap">Overlap (seconds)</label>
          <input id="overlap" type="number" min={0} max={604800} className="input w-28" value={overlap} onChange={(ev) => setOverlap(Number(ev.target.value))} />
        </div>
        <button type="button" className="btn-secondary" onClick={() => void rotate()}><RotateKeyIcon /> Rotate</button>
      </div>
      {error && <ErrorNote message={error} />}
    </section>
  )
}
