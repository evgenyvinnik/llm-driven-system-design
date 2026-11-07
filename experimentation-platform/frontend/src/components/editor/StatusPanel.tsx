import { useState } from 'react'
import type { FlagStatus } from '@exp/core'
import { PauseIcon, PlayIcon, StopIcon } from '@/components/icons'
import { StatusChip } from '@/components/shared/StatusChip'
import { dateTime } from '@/lib/format'
import { api, ApiError } from '@/services/api'
import type { Flag } from '@/types'
import { KillSwitch } from './KillSwitch'

const LABELS: Record<FlagStatus, { label: string; Icon: typeof PlayIcon }> = {
  running: { label: 'Start', Icon: PlayIcon },
  paused: { label: 'Pause', Icon: PauseIcon },
  stopped: { label: 'Stop', Icon: StopIcon },
  draft: { label: 'Draft', Icon: PlayIcon },
}

export function StatusPanel({ flag, env, canEdit, onChanged }: { flag: Flag; env: string; canEdit: boolean; onChanged: () => void }) {
  const cfg = flag.configs[env]
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function move(to: FlagStatus) {
    if (to === 'stopped' && !window.confirm(`Stop ${flag.key} in ${env}? Stopping is final.`)) return
    setBusy(true)
    setError(null)
    try {
      await api.setStatus(flag.key, env, cfg.version, to)
      onChanged()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Status change failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="card space-y-4 p-4" aria-label="Status">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <StatusChip status={cfg.status} />
          <span className="num text-sm text-slate-600">
            config <span className="font-semibold">v{cfg.version}</span> in {env}
          </span>
          <span className="text-xs text-slate-400">
            started {dateTime(cfg.startedAt)} {cfg.stoppedAt && `· stopped ${dateTime(cfg.stoppedAt)}`} · last change by {cfg.updatedBy ?? '—'}
          </span>
        </div>
        <div className="flex gap-2">
          {cfg.allowedTransitions.map((to) => {
            const { label, Icon } = cfg.status === 'paused' && to === 'running' ? { label: 'Resume', Icon: PlayIcon } : LABELS[to]
            return (
              <button key={to} type="button" className="btn-secondary" disabled={!canEdit || busy} onClick={() => void move(to)}>
                <Icon className="h-3.5 w-3.5" /> {label}
              </button>
            )
          })}
        </div>
      </div>
      {error && <p className="text-xs font-medium text-rose-700">{error}</p>}
      <KillSwitch flag={flag} env={env} canEdit={canEdit} onDone={onChanged} />
    </section>
  )
}
