import { Link } from '@tanstack/react-router'
import { useState } from 'react'
import { AlertIcon, PauseIcon, PlayIcon, StopIcon } from '@/components/icons'
import { CampaignStatusBadge, ErrorNote } from '@/components/shared'
import { relativeTime } from '@/lib/format'
import { api } from '@/services/api'
import type { StreamMode } from '@/services/campaign-stream'
import type { Campaign } from '@/types'

const MODE: Record<StreamMode, { label: string; dot: string }> = {
  connecting: { label: 'connecting', dot: 'bg-slate-400' },
  live: { label: 'live (SSE)', dot: 'bg-status-good animate-pulseDot' },
  polling: { label: 'polling every 3s', dot: 'bg-status-warning' },
  closed: { label: 'offline', dot: 'bg-slate-300' },
}

export function CampaignHeader({ campaign, mode, canControl, onChanged }: { campaign: Campaign; mode: StreamMode; canControl: boolean; onChanged: () => void }) {
  const [error, setError] = useState<unknown>(null)
  const act = (action: 'start' | 'pause' | 'resume' | 'kill') => {
    if (action === 'kill' && !window.confirm('Kill stops all new writes. Accounts already changed keep baking and can still roll back. Continue?')) return
    api.transition(campaign.id, action).then(onChanged, setError)
  }
  const s = campaign.status
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link to="/campaigns" className="text-xs text-accent-700 hover:underline">← Campaigns</Link>
          <h1 className="page-title">{campaign.name}</h1>
          <p className="text-sm text-slate-500">
            <span className="font-mono">{campaign.controlId}</span> · bake {campaign.config.bakeSeconds}s · canary {campaign.config.canaryPercent}% · growth ×{campaign.config.growthFactor} · failure budget {campaign.config.maxFailuresPerWave}/wave · created by {campaign.createdBy} {relativeTime(campaign.createdAt)}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1.5 text-xs text-slate-500"><span className={`h-2 w-2 rounded-full ${MODE[mode].dot}`} aria-hidden /> {MODE[mode].label}</span>
          <CampaignStatusBadge status={s} />
          {canControl && s === 'draft' && <button type="button" className="btn-primary" onClick={() => act('start')}><PlayIcon /> Start</button>}
          {canControl && s === 'running' && <button type="button" className="btn-secondary" onClick={() => act('pause')}><PauseIcon /> Pause</button>}
          {canControl && s === 'paused' && <button type="button" className="btn-primary" onClick={() => act('resume')}><PlayIcon /> Resume</button>}
          {canControl && ['draft', 'running', 'paused'].includes(s) && <button type="button" className="btn-danger" onClick={() => act('kill')}><StopIcon /> Kill</button>}
        </div>
      </div>
      {campaign.statusReason && s === 'paused' && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-900">
          <AlertIcon className="mt-0.5 h-4 w-4 shrink-0 text-status-warning" />
          <span>{campaign.statusReason}</span>
        </div>
      )}
      <ErrorNote error={error} />
    </div>
  )
}
