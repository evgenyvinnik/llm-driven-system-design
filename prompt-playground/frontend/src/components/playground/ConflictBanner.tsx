import { AlertIcon } from '@/components/icons'
import type { VersionDetail } from '@/types'

interface Props {
  head: VersionDetail
  onDiscardMine: () => void
  onKeepMine: () => void
}

/**
 * Shown when someone saved a newer version after this draft was started.
 * Versions are append-only, so nothing is lost either way; the choice is
 * whether to build on their version or put this draft on top of it.
 */
export function ConflictBanner({ head, onDiscardMine, onKeepMine }: Props) {
  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-amber-200 bg-amber-50 px-5 py-2 text-sm text-amber-900">
      <AlertIcon className="h-4 w-4 shrink-0" />
      <span className="flex-1">
        <strong>{head.createdBy.displayName}</strong> saved v{head.version}
        {head.message ? ` (“${head.message}”)` : ''} after you started editing.
      </span>
      <button className="btn-secondary py-1 text-xs" onClick={onDiscardMine}>
        Load v{head.version}, discard my edits
      </button>
      <button className="btn-primary py-1 text-xs" onClick={onKeepMine}>
        Keep my edits on top of v{head.version}
      </button>
    </div>
  )
}
