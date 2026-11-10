import { LockIcon } from '@/components/icons'
import { sourceLabel } from '@/lib/display'
import type { EffectiveEntry } from '@/types'

const TONE: Record<EffectiveEntry['source'], string> = {
  enforced: 'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300',
  user: 'bg-accent-100 text-accent-700 dark:bg-accent-500/20 dark:text-accent-100',
  org: 'bg-sky-100 text-sky-800 dark:bg-sky-500/15 dark:text-sky-300',
  default: 'bg-sunken text-muted',
}

/** Where the effective value came from, and a lock when the user can't change it. */
export function SourceBadge({ entry, orgName }: { entry: EffectiveEntry; orgName: string }) {
  return (
    <span className={`chip ${TONE[entry.source]}`} data-source={entry.source}>
      {entry.locked && <LockIcon className="h-3 w-3" />}
      {sourceLabel(entry, orgName)}
    </span>
  )
}
