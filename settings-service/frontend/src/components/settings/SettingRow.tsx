import { ResetIcon } from '@/components/icons'
import { displayValue, formatValue, timeAgo } from '@/lib/display'
import type { PendingEdit } from '@/lib/settings-store'
import type { Definition, EffectiveEntry, SettingValue } from '@/types'
import { PendingNote } from './PendingNote'
import { SettingControl } from './SettingControl'
import { SourceBadge } from './SourceBadge'

export interface SettingRowProps {
  def: Definition
  entry: EffectiveEntry | undefined
  pending: PendingEdit | undefined
  orgName: string
  flashAt?: number
  dense?: boolean
  onChange: (value: SettingValue | null) => void
  onResolve: (choice: 'mine' | 'theirs') => void
  onDismiss: () => void
}

export function SettingRow({ def, entry, pending, orgName, flashAt, dense, onChange, onResolve, onDismiss }: SettingRowProps) {
  if (!entry) return null
  const busy = pending?.status === 'saving' || pending?.status === 'unknown'
  const recent = flashAt !== undefined && Date.now() - flashAt < 2500
  const canReset = entry.source === 'user' && !entry.locked && !entry.deprecated && !pending
  return (
    <div className={`setting-row ${dense ? 'px-4 py-3' : ''} ${recent ? 'animate-flash' : ''}`} data-key={def.key} data-source={entry.source}>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-ink">{def.label}</span>
          <SourceBadge entry={entry} orgName={orgName} />
          {entry.deprecated && (
            <span className="chip bg-sunken text-muted" title={def.replacedBy ? `Replaced by ${def.replacedBy}` : undefined}>
              Deprecated{def.sunsetAt ? ` · retires ${new Date(def.sunsetAt).toLocaleDateString()}` : ''}
            </span>
          )}
        </div>
        {!dense && <p className="mt-0.5 text-xs text-muted">{def.description}</p>}
        {!dense && <RowMeta def={def} entry={entry} orgName={orgName} />}
      </div>
      <div className="flex items-center gap-2">
        {canReset && !dense && (
          <button type="button" className="rounded-md p-1.5 text-faint hover:bg-sunken hover:text-ink" title="Reset to inherited value" aria-label={`Reset ${def.label}`} onClick={() => onChange(null)}>
            <ResetIcon className="h-4 w-4" />
          </button>
        )}
        <SettingControl def={def} value={displayValue(entry, pending)} disabled={entry.locked || busy || entry.deprecated === true} onChange={onChange} />
      </div>
      {pending && (
        <div className="basis-full">
          <PendingNote def={def} pending={pending} onResolve={onResolve} onDismiss={onDismiss} />
        </div>
      )}
    </div>
  )
}

function RowMeta({ def, entry, orgName }: { def: Definition; entry: EffectiveEntry; orgName: string }) {
  if (entry.source === 'enforced') {
    return (
      <p className="mt-1 text-xs text-amber-800 dark:text-amber-300">
        {orgName} requires this.
        {entry.userValue !== undefined && ` Your own choice (${formatValue(def, entry.userValue)}) is kept and applies again if the policy is lifted.`}
      </p>
    )
  }
  if (entry.lockReason === 'org_scope') return <p className="mt-1 text-xs text-faint">Only {orgName} administrators can change this.</p>
  if (entry.source === 'user' && entry.updatedAt) {
    return (
      <p className="mt-1 text-xs text-faint">
        Changed {entry.updatedBy ? `on ${entry.updatedBy} ` : ''}
        {timeAgo(entry.updatedAt)} · r{entry.rev}
      </p>
    )
  }
  return null
}
