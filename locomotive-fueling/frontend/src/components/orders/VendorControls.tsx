import { useEffect, useState } from 'react'
import { api } from '@/services/api'
import type { VendorSettings } from '@/types'

/** Fault switches on the mock DTL vendor, to rehearse the unknown-outcome and refusal paths. */
export function VendorControls() {
  const [settings, setSettings] = useState<VendorSettings | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    api.vendor().then(setSettings, (e: Error) => setError(e.message))
  }, [])
  const arm = async (patch: Partial<VendorSettings>) => {
    try {
      setSettings(await api.updateVendor(patch))
    } catch (e) {
      setError((e as Error).message)
    }
  }
  if (error) return <div className="card p-4 text-sm text-slate-500">Mock vendor controls unavailable: {error}</div>
  if (!settings) return null
  return (
    <div className="card p-4">
      <div className="panel-title mb-2">Mock vendor fault switches</div>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <button type="button" className="btn-secondary" onClick={() => void arm({ timeoutNext: settings.timeoutNext + 1 })}>
          Next order times out ({settings.timeoutNext})
        </button>
        <button type="button" className="btn-secondary" onClick={() => void arm({ failNext: settings.failNext + 1 })}>
          Next order gets 500 ({settings.failNext})
        </button>
        <button type="button" className="btn-secondary" onClick={() => void arm({ rejectNext: settings.rejectNext + 1 })}>
          Next order refused ({settings.rejectNext})
        </button>
        <button type="button" className="btn-secondary" onClick={() => void arm({ shortFillPct: settings.shortFillPct ? 0 : 15 })}>
          Short fill: {settings.shortFillPct}%
        </button>
        <span className="text-xs text-slate-500">Latency {settings.latencyMs} ms · our client waits 2.5 s, then treats the outcome as unknown</span>
      </div>
    </div>
  )
}
