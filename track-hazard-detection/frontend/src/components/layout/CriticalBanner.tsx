import { Link } from '@tanstack/react-router'
import { useState } from 'react'
import { AlertIcon, XIcon } from '@/components/icons'
import { useTicker } from '@/lib/hooks'
import { useLiveStore } from '@/stores/live-store'

/** A banner on every page for a CRITICAL alert issued or re-issued in the last two minutes. */
export function CriticalBanner() {
  const last = useLiveStore((s) => s.lastCritical)
  const [dismissed, setDismissed] = useState<number | null>(null)
  const now = useTicker(5000)
  if (!last || dismissed === last.at || now - last.at > 120_000) return null
  return (
    <div role="alert" className="flex items-center gap-3 bg-sev-critical px-6 py-2 text-sm font-medium text-white">
      <AlertIcon className="h-4 w-4" />
      <span>New CRITICAL hazard alert.</span>
      <Link to="/hazards/$hazardId" params={{ hazardId: last.hazardId }} className="underline underline-offset-2" onClick={() => setDismissed(last.at)}>
        Open hazard
      </Link>
      <button type="button" className="ml-auto rounded p-1 hover:bg-white/20" onClick={() => setDismissed(last.at)} title="Dismiss">
        <XIcon className="h-4 w-4" />
      </button>
    </div>
  )
}
