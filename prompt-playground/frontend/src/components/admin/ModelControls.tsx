import { useEffect, useState } from 'react'
import { SlidersIcon } from '@/components/icons'
import { api, ApiError } from '@/services/api'
import type { ModelSettings } from '@/types'

/** Knobs on the mock model service, for exercising failure, latency, and overload paths on demand. */
export function ModelControls() {
  const [settings, setSettings] = useState<ModelSettings | null>(null)
  const [active, setActive] = useState(0)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api
      .modelSettings()
      .then((res) => {
        setSettings(res.settings)
        setActive(res.active)
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Model service unreachable'))
  }, [])

  async function update(patch: Partial<ModelSettings>) {
    try {
      const res = await api.updateModelSettings(patch)
      setSettings(res.settings)
      setActive(res.active)
      setError(null)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Update failed')
    }
  }

  return (
    <div className="card p-4">
      <div className="mb-3 flex items-center gap-2">
        <SlidersIcon className="h-4 w-4 text-slate-500" />
        <span className="panel-title">Mock model controls</span>
        <span className="ml-auto text-xs text-slate-500">{active} generating now</span>
      </div>
      {error && <p className="mb-2 text-xs text-red-700">{error}</p>}
      {settings && (
        <div className="space-y-3 text-xs">
          <div className="flex items-center justify-between gap-3">
            <label className="font-medium text-slate-600" htmlFor="failure-rate">
              Failure rate override
            </label>
            <select
              id="failure-rate"
              className="input w-44 py-1 text-xs"
              value={settings.failureRateOverride === null ? '' : String(settings.failureRateOverride)}
              onChange={(e) => void update({ failureRateOverride: e.target.value === '' ? null : Number(e.target.value) })}
            >
              <option value="">Per model (default)</option>
              <option value="0">0% — never fail</option>
              <option value="0.25">25%</option>
              <option value="0.5">50%</option>
              <option value="1">100% — always fail</option>
            </select>
          </div>
          <div className="flex items-center justify-between gap-3">
            <label className="font-medium text-slate-600" htmlFor="latency">
              Latency multiplier
            </label>
            <select id="latency" className="input w-44 py-1 text-xs" value={settings.latencyMultiplier} onChange={(e) => void update({ latencyMultiplier: Number(e.target.value) })}>
              {[0.5, 1, 2, 5, 10].map((v) => (
                <option key={v} value={v}>
                  {v}×
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-center justify-between gap-3">
            <label className="font-medium text-slate-600" htmlFor="slots">
              Concurrent generations
            </label>
            <select id="slots" className="input w-44 py-1 text-xs" value={settings.maxConcurrent} onChange={(e) => void update({ maxConcurrent: Number(e.target.value) })}>
              {[1, 2, 4, 8, 16, 32].map((v) => (
                <option key={v} value={v}>
                  {v} {v === 1 ? 'slot' : 'slots'}
                </option>
              ))}
            </select>
          </div>
          <p className="text-slate-500">
            With fewer slots than in-flight runs, the model answers 429 and the executor retries before the first token.
          </p>
        </div>
      )}
    </div>
  )
}
