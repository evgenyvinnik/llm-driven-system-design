import { useEffect, useState } from 'react'
import { ZapIcon } from '@/components/icons'
import { api } from '@/services/api'

/**
 * The armed-count chaos switch: the next N PATCHes (from any device of this
 * user, on either instance) commit, then lose their response.
 */
export function ChaosBar() {
  const [armed, setArmed] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    const poll = () =>
      api
        .getChaos()
        .then((c) => alive && setArmed(c.dropNextPatchResponses))
        .catch(() => alive && setArmed(null))
    void poll()
    const t = setInterval(poll, 2000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [])

  async function arm(n: number) {
    setError(null)
    try {
      setArmed((await api.setChaos(n)).dropNextPatchResponses)
    } catch {
      setError('Chaos switch unavailable (CHAOS_ENABLED=false?)')
    }
  }

  return (
    <div className="card flex flex-wrap items-center gap-3 p-3 text-sm">
      <ZapIcon className="h-4 w-4 text-amber-600" />
      <div className="mr-auto">
        <p className="font-medium text-ink">Lost response</p>
        <p className="text-xs text-muted">The next PATCH commits on the server, then its connection is cut. The client can&apos;t know whether it saved.</p>
      </div>
      <span className="font-mono text-xs text-muted" data-armed={armed ?? ''}>
        armed: {armed ?? '–'}
      </span>
      <button type="button" className="btn-primary" onClick={() => void arm((armed ?? 0) + 1)} data-action="arm-chaos">
        Drop next response
      </button>
      {(armed ?? 0) > 0 && (
        <button type="button" className="btn-ghost" onClick={() => void arm(0)}>
          Disarm
        </button>
      )}
      {error && <p className="basis-full text-xs text-red-700">{error}</p>}
    </div>
  )
}
