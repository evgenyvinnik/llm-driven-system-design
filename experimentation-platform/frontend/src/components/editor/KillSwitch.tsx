/**
 * The kill switch: force a flag off (paused, resumable) or stop an experiment
 * (final). Every unit gets the default variant as soon as its SDK receives the
 * new snapshot; the Live SDK clients page shows that happening.
 */
import { Link } from '@tanstack/react-router'
import { useState } from 'react'
import { PowerIcon } from '@/components/icons'
import { api, ApiError } from '@/services/api'
import type { Flag } from '@/types'

export function KillSwitch({ flag, env, canEdit, onDone }: { flag: Flag; env: string; canEdit: boolean; onDone: () => void }) {
  const cfg = flag.configs[env]
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ version: number; at: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const live = cfg.status === 'running'
  const what = flag.kind === 'flag' ? 'Force off' : 'Stop experiment'

  async function kill() {
    setBusy(true)
    setError(null)
    try {
      const res = await api.kill(flag.key, env, reason)
      setResult({ version: res.snapshotVersion, at: res.publishedAt })
      setOpen(false)
      setReason('')
      onDone()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Kill switch failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded-lg border border-rose-200 bg-rose-50/60 p-4" data-testid="kill-switch">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-sm font-semibold text-rose-800">
            <PowerIcon className="h-4 w-4" /> Kill switch
          </div>
          <p className="mt-1 text-xs text-rose-900/70">
            {flag.kind === 'flag'
              ? 'Serves "off" to everyone (status → paused; resume later).'
              : 'Serves control to everyone and ends the experiment (status → stopped, final).'}{' '}
            Pushed to every connected SDK within seconds.
          </p>
        </div>
        {!open && (
          <button
            type="button"
            className="btn shrink-0 bg-rose-600 text-white hover:bg-rose-700"
            disabled={!canEdit || !live}
            title={!canEdit ? 'Viewers cannot use the kill switch' : !live ? `Already ${cfg.status}` : undefined}
            onClick={() => setOpen(true)}
          >
            <PowerIcon /> {what}
          </button>
        )}
      </div>
      {open && (
        <div className="mt-3 flex gap-2">
          <input className="input" autoFocus placeholder="Reason (written to the audit log)" value={reason} onChange={(e) => setReason(e.target.value)} />
          <button type="button" className="btn shrink-0 bg-rose-600 text-white hover:bg-rose-700" disabled={busy || reason.trim().length === 0} onClick={() => void kill()}>
            Confirm {what.toLowerCase()}
          </button>
          <button type="button" className="btn-ghost" onClick={() => setOpen(false)}>
            Cancel
          </button>
        </div>
      )}
      {error && <p className="mt-2 text-xs font-medium text-rose-800">{error}</p>}
      {result && (
        <p className="mt-2 text-xs text-rose-900">
          Snapshot v{result.version} published at {new Date(result.at).toLocaleTimeString('en-US', { hour12: false })}.{' '}
          <Link to="/clients" className="font-medium underline">
            Watch it reach clients →
          </Link>
        </p>
      )}
    </div>
  )
}
