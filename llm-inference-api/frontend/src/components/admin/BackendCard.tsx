import { useState } from 'react'
import { ServerIcon } from '@/components/icons'
import { Meter } from '@/components/shared/StatTile'
import { StatusChip } from '@/components/shared/StatusChip'
import { int, pct } from '@/lib/format'
import { api } from '@/services/api'
import type { BackendView } from '@/types'
import { ChaosControls } from './ChaosControls'

function nextVersion(v: string | undefined): string {
  const m = v?.match(/^(.*?)(\d{4})-(\d{2})$/)
  if (!m) return `${v ?? 'mock-large'}-next`
  const month = Number(m[3]) + 1
  return month > 12 ? `${m[1]}${Number(m[2]) + 1}-01` : `${m[1]}${m[2]}-${String(month).padStart(2, '0')}`
}

export function BackendCard({ b, onChange }: { b: BackendView; onChange: () => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
      onChange()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed')
    } finally {
      setBusy(false)
    }
  }
  const status = b.reachable ? b.status : 'unknown'
  const slots = b.slots ?? 0
  const inUse = b.inUse ?? 0

  return (
    <article className="card space-y-3 p-4" aria-label={`Backend ${b.id}`} data-testid={`backend-${b.id}`}>
      <header className="flex items-center gap-2">
        <ServerIcon className="h-5 w-5 text-slate-500" />
        <h3 className="font-semibold text-slate-900">{b.id}</h3>
        <StatusChip status={status} />
        {b.routable === false && b.reachable && b.status === 'ok' && <span className="chip bg-amber-50 text-amber-800">cooldown {b.cooldownReason}</span>}
        <span className="ml-auto font-mono text-xs text-slate-500">{b.version ?? '–'}</span>
      </header>
      {b.targetVersion && <p className="text-xs text-amber-800">Upgrading to {b.targetVersion}: draining, then switching with a cold cache.</p>}
      <div>
        <div className="mb-1 flex justify-between text-xs text-slate-600">
          <span>
            Slots <span className="num font-medium text-slate-900">{inUse}</span> / {slots} ({b.prefilling ?? 0} prefilling, {b.decoding ?? 0} decoding)
          </span>
          <span>{b.batching} batching</span>
        </div>
        <Meter value={inUse} max={slots} tone={inUse >= slots ? 'bg-red-500' : 'bg-sky-500'} label={`${b.id} slots in use`} />
      </div>
      <dl className="grid grid-cols-3 gap-2 text-xs">
        <div>
          <dt className="text-slate-500">Prefix cache hit</dt>
          <dd className="num text-base font-semibold text-slate-900">{pct(b.cache?.hitRate ?? null)}</dd>
        </div>
        <div>
          <dt className="text-slate-500">Cached prefixes</dt>
          <dd className="num text-base font-semibold text-slate-900">
            {b.cache?.entries ?? 0}/{b.cache?.capacity ?? 0}
          </dd>
        </div>
        <div>
          <dt className="text-slate-500">Tokens generated</dt>
          <dd className="num text-base font-semibold text-slate-900">{int(b.counters?.tokens ?? 0)}</dd>
        </div>
      </dl>
      <div className="flex flex-wrap gap-2">
        {b.status === 'draining' && !b.targetVersion ? (
          <button type="button" className="btn-secondary btn-xs" disabled={busy} onClick={() => act(() => api.drain(b.id, false))}>Undrain</button>
        ) : (
          <button type="button" className="btn-secondary btn-xs" disabled={busy || !b.reachable || b.status !== 'ok'} onClick={() => act(() => api.drain(b.id, true))}>Drain</button>
        )}
        <button type="button" className="btn-secondary btn-xs" disabled={busy || !b.reachable || !!b.targetVersion} onClick={() => act(() => api.upgrade(b.id, nextVersion(b.version)))}>
          Roll to {nextVersion(b.version)}
        </button>
        <button
          type="button"
          className="btn-secondary btn-xs"
          disabled={busy || !b.reachable}
          onClick={() => act(() => api.backendSettings(b.id, { batching: b.batching === 'static' ? 'continuous' : 'static' }))}
        >
          Use {b.batching === 'static' ? 'continuous' : 'static'}
        </button>
      </div>
      <ChaosControls chaos={b.chaos ?? {}} disabled={busy || !b.reachable} onArm={(kind, n) => act(() => api.backendSettings(b.id, { chaos: { [kind]: n } }))} />
      {error && <p className="text-xs text-red-700">{error}</p>}
    </article>
  )
}
