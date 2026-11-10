import { KeyIcon } from '@/components/icons'
import { int } from '@/lib/format'
import { useConsoleStore } from '@/stores/console-store'

export function KeyPicker() {
  const orgs = useConsoleStore((s) => s.orgs)
  const keyId = useConsoleStore((s) => s.keyId)
  const setKey = useConsoleStore((s) => s.setKey)
  const org = orgs.find((o) => o.keys.some((k) => k.id === keyId))

  return (
    <div>
      <label className="label" htmlFor="api-key">
        API key
      </label>
      <div className="relative">
        <KeyIcon className="pointer-events-none absolute left-2.5 top-2 h-4 w-4 text-slate-400" />
        <select id="api-key" name="apiKey" className="input pl-8" value={keyId ?? ''} onChange={(e) => setKey(e.target.value)}>
          {orgs.map((o) => (
            <optgroup key={o.id} label={`${o.name} · ${o.tier} tier`}>
              {o.keys.map((k) => (
                <option key={k.id} value={k.id}>
                  {o.name} / {k.name} ({k.prefix})
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </div>
      {org && (
        <p className="mt-1.5 text-xs text-slate-500">
          <span className="font-medium text-slate-700">{org.tier}</span> tier: {int(org.limits.tokensPerMinute)} tokens/min, {int(org.limits.requestsPerMinute)} req/min, queue share{' '}
          {org.limits.maxQueuedInteractive} interactive / {org.limits.maxQueuedBatch} bulk · <span className="num font-medium text-slate-700">{int(org.tokensAvailable)}</span> tokens available now
        </p>
      )}
    </div>
  )
}
