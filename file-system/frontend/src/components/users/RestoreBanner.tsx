import { XIcon } from '@/components/icons'
import type { RestoreResult } from '@/types'

export function RestoreBanner({ result, onClose }: { result: RestoreResult; onClose: () => void }) {
  const skipped = result.skipped.length
  return (
    <div className={`card flex gap-3 px-4 py-3 ${skipped > 0 ? 'border-amber-200 bg-amber-50' : 'border-accent-200 bg-accent-50'}`}>
      <div className="flex-1 text-sm text-slate-700">
        <p className="font-medium text-slate-900">
          Restored {result.restored} {result.restored === 1 ? 'file' : 'files'} for {result.id}
          {skipped > 0 && `, skipped ${skipped}`}
        </p>
        {skipped > 0 && (
          <>
            <p className="mt-1">These backed-up paths are now held by someone else, so the restore left them alone:</p>
            <ul className="mt-1 list-inside list-disc font-mono text-xs">
              {result.skipped.map((path) => (
                <li key={path}>{path}</li>
              ))}
            </ul>
          </>
        )}
      </div>
      <button className="self-start text-slate-400 hover:text-slate-700" onClick={onClose} aria-label="Dismiss">
        <XIcon />
      </button>
    </div>
  )
}
