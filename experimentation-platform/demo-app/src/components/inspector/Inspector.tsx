/**
 * Experiment inspector: what the SDK on this page knows and did. Identity,
 * snapshot source and version, connection, every flag's evaluation, and which
 * experiments this unit has actually been exposed to. The offline switch and
 * cache reset demonstrate last-known-good startup and coded defaults.
 */
import { useState } from 'react'
import { useClientState, useExperimentClient } from 'experimentation-sdk/react'
import { BugIcon, WifiOffIcon, XIcon } from '@/components/icons'
import { clearSdkCache, isOffline, setOffline } from '@/lib/experiments'
import { EvaluationTable } from './EvaluationTable'

const SOURCE_STYLE: Record<string, string> = {
  network: 'bg-emerald-100 text-emerald-800',
  cache: 'bg-amber-100 text-amber-800',
  bootstrap: 'bg-sky-100 text-sky-800',
  defaults: 'bg-rose-100 text-rose-800',
}

export function Inspector() {
  const client = useExperimentClient()
  const state = useClientState()
  const [open, setOpen] = useState(true)
  const offline = isOffline()
  const reload = (fn: () => void) => {
    fn()
    window.location.reload()
  }

  if (!open) {
    return (
      <button type="button" className="fixed bottom-4 right-4 z-20 inline-flex items-center gap-2 rounded-full bg-stone-900 px-4 py-2 text-xs font-semibold text-white shadow-lg" onClick={() => setOpen(true)}>
        <BugIcon /> Experiment inspector
      </button>
    )
  }

  const ctx = state.context
  return (
    <aside className="fixed bottom-4 right-4 z-20 w-[500px] rounded-2xl border border-stone-700 bg-stone-900 p-4 text-xs text-stone-200 shadow-2xl" aria-label="Experiment inspector" data-inspector="open">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-semibold text-white">
          <BugIcon /> Experiment inspector
        </div>
        <button type="button" className="rounded p-1 hover:bg-stone-800" onClick={() => setOpen(false)} title="Hide">
          <XIcon />
        </button>
      </div>
      <dl className="grid grid-cols-[96px_1fr] gap-x-2 gap-y-1">
        <dt className="text-stone-400">anonymous id</dt>
        <dd className="truncate font-mono">{ctx.anonymousId}</dd>
        <dt className="text-stone-400">user id</dt>
        <dd className="truncate font-mono">{ctx.userId ?? '— (signed out)'}</dd>
        <dt className="text-stone-400">stable id</dt>
        <dd className="truncate font-mono" data-testid="stable-id">
          {ctx.stableId}
          {ctx.userId && ctx.stableId === ctx.anonymousId && <span className="ml-1 text-stone-400">(this device’s anonymous id)</span>}
          {ctx.userId && ctx.stableId !== ctx.anonymousId && <span className="ml-1 text-amber-300">(alias from the first device)</span>}
        </dd>
        <dt className="text-stone-400">snapshot</dt>
        <dd className="flex items-center gap-1.5" data-testid="snapshot">
          <span className="font-mono font-semibold text-white">v{state.version}</span>
          <span className={`tag ${SOURCE_STYLE[state.source]}`}>{state.source}</span>
          <span className={`tag ${state.connection === 'live' ? 'bg-emerald-900 text-emerald-200' : 'bg-stone-700 text-stone-200'}`}>{state.connection === 'live' ? 'SSE live' : state.connection}</span>
        </dd>
        <dt className="text-stone-400">events</dt>
        <dd>
          {state.queued} queued · {state.exposuresLogged} exposure{state.exposuresLogged === 1 ? '' : 's'} logged this page
        </dd>
      </dl>
      <EvaluationTable client={client} />
      {state.lastError && <p className="mt-2 truncate text-amber-300">last error: {state.lastError}</p>}
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" className="inline-flex items-center gap-1 rounded-full bg-stone-700 px-3 py-1 hover:bg-stone-600" onClick={() => reload(() => setOffline(!offline))}>
          <WifiOffIcon className="h-3.5 w-3.5" /> {offline ? 'Go back online (reload)' : 'Reload offline'}
        </button>
        <button type="button" className="rounded-full bg-stone-700 px-3 py-1 hover:bg-stone-600" onClick={() => reload(clearSdkCache)}>
          Clear SDK cache (reload)
        </button>
      </div>
    </aside>
  )
}
