import { AlertIcon, CheckIcon } from '@/components/icons'
import { relativeTime } from '@/lib/format'
import type { Posture } from '@/types'

/** Tells readers how old the numbers are and where they come from, so they can trust them. */
export function FreshnessBanner({ freshness }: { freshness: Posture['freshness'] }) {
  const fullAge = freshness.lastFullScanAt ? Date.now() - Date.parse(freshness.lastFullScanAt) : Infinity
  const feedAge = freshness.changeFeedPolledAt ? Date.now() - Date.parse(freshness.changeFeedPolledAt) : Infinity
  const healthy = fullAge < 15 * 60_000 && feedAge < 60_000
  return (
    <div className={`flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border px-4 py-2 text-xs ${healthy ? 'border-slate-200 bg-white text-slate-600' : 'border-amber-200 bg-amber-50 text-amber-900'}`}>
      <span className="inline-flex items-center gap-1.5 font-semibold">
        {healthy ? <CheckIcon className="h-3.5 w-3.5 text-status-good" /> : <AlertIcon className="h-3.5 w-3.5 text-status-warning" />}
        {healthy ? 'Data is fresh' : 'Data may be stale'}
      </span>
      <span>Full inventory scan {relativeTime(freshness.lastFullScanAt)}{freshness.lastFullScanMs !== null ? ` (${(freshness.lastFullScanMs / 1000).toFixed(1)}s)` : ''}</span>
      <span>Change feed polled {relativeTime(freshness.changeFeedPolledAt)}</span>
      <span>Last config change seen {relativeTime(freshness.lastChangeEventAt)}</span>
      <span className="text-slate-400">Full scans read Resource Graph, which lags ARM; changes are re-read from ARM directly.</span>
    </div>
  )
}
