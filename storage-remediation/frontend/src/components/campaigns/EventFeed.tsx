import { relativeTime } from '@/lib/format'
import type { CampaignEvent } from '@/types'

const TONE: Record<string, string> = {
  'target.rolled_back': 'text-orange-800',
  'target.rollback_started': 'text-orange-800',
  'target.rollback_failed': 'text-red-700',
  'target.failed': 'text-red-700',
  'target.escalated': 'text-amber-800',
  'campaign.paused': 'text-amber-800',
  'target.throttled': 'text-slate-500',
  'target.verified': 'text-green-800',
}

export function EventFeed({ events }: { events: CampaignEvent[] }) {
  const interesting = events.filter((e) => e.type !== 'target.deferred')
  return (
    <div className="card flex max-h-[30rem] flex-col">
      <div className="border-b border-slate-100 px-4 py-3 text-sm font-semibold text-slate-800">Live events</div>
      <ol className="flex-1 divide-y divide-slate-50 overflow-y-auto">
        {interesting.length === 0 && <li className="px-4 py-6 text-sm text-slate-500">Waiting for events…</li>}
        {interesting.slice(0, 80).map((e, i) => (
          <li key={e.id ?? i} className="px-4 py-1.5 text-xs">
            <div className="flex justify-between gap-2">
              <span className={`font-semibold ${TONE[e.type] ?? 'text-slate-700'}`}>{e.type.replace('target.', '').replace('_', ' ')}{e.outcome && e.outcome !== 'written' ? ` (${e.outcome.replaceAll('_', ' ')})` : ''}</span>
              <span className="shrink-0 text-slate-400">{relativeTime(e.at)}</span>
            </div>
            {e.accountId && <div className="font-mono text-slate-600">{e.accountId.split('/').pop()}{e.waveNo ? ` · W${e.waveNo}` : ''}</div>}
            {e.message && <div className="text-slate-500">{e.message}</div>}
          </li>
        ))}
      </ol>
    </div>
  )
}
