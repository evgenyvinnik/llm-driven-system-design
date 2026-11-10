import { useState } from 'react'
import { SettingControl } from '@/components/settings/SettingControl'
import { Toggle } from '@/components/settings/Toggle'
import { formatValue } from '@/lib/display'
import { ApiError, api } from '@/services/api'
import type { Definition, PolicyItem, SettingValue } from '@/types'

interface Props {
  def: Definition
  item: PolicyItem
  orgRevision: number
  memberCount: number
  onChanged: (message: string) => void
}

/** One key's org policy: value, enforced flag, and how many members an enforcement would shadow. */
export function PolicyRow({ def, item, orgRevision, memberCount, onChanged }: Props) {
  const [value, setValue] = useState<SettingValue>(item.value ?? def.defaultValue)
  const [enforced, setEnforced] = useState(item.enforced)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const hasPolicy = item.value !== null
  const dirty = !hasPolicy ? value !== def.defaultValue || enforced : value !== item.value || enforced !== item.enforced
  const deprecated = item.status === 'deprecated'

  async function run(action: () => Promise<unknown>, message: string) {
    setBusy(true)
    setError(null)
    try {
      await action()
      onChanged(message)
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) onChanged(`${def.key}: another admin changed it first (409); reloaded`)
      else setError(err instanceof ApiError ? err.body.message : 'Outcome unknown; reload to check')
    } finally {
      setBusy(false)
    }
  }

  return (
    <tr className="align-top" data-key={def.key}>
      <td className="px-4 py-3">
        <div className="text-sm font-medium text-ink">{def.label}</div>
        <div className="font-mono text-[11px] text-faint">{def.key}</div>
        <div className="mt-1 flex flex-wrap gap-1">
          {def.scope === 'org' && <span className="chip bg-sky-100 text-sky-800 dark:bg-sky-500/15 dark:text-sky-300">org setting</span>}
          {deprecated && <span className="chip bg-sunken text-muted">deprecated</span>}
        </div>
      </td>
      <td className="px-4 py-3 text-sm text-muted">{formatValue(def, def.defaultValue)}</td>
      <td className="px-4 py-3">
        <SettingControl key={`${item.rev}`} def={def} value={value} disabled={busy || deprecated} onChange={setValue} />
        {!hasPolicy && <p className="mt-1 text-[11px] text-faint">No policy: members inherit the global default</p>}
      </td>
      <td className="px-4 py-3">
        {def.scope === 'user' ? (
          <Toggle checked={enforced} disabled={busy || deprecated} label={`Enforce ${def.label}`} name={`enforce:${def.key}`} onChange={setEnforced} />
        ) : (
          <span className="text-xs text-faint">always</span>
        )}
      </td>
      <td className="px-4 py-3 text-sm tabular-nums text-muted">
        {item.overrideCount} / {memberCount}
        {enforced && item.overrideCount > 0 && <p className="text-[11px] text-amber-700 dark:text-amber-300">shadowed, not deleted</p>}
      </td>
      <td className="px-4 py-3">
        <div className="flex flex-wrap gap-1.5">
          <button
            type="button"
            className="btn-primary px-2 py-1 text-xs"
            disabled={!dirty || busy || deprecated}
            onClick={() => void run(() => api.setPolicy(def.key, value, enforced, orgRevision), `${def.key} → ${formatValue(def, value)}${enforced ? ' (enforced)' : ''}`)}
          >
            Save
          </button>
          {hasPolicy && (
            <button type="button" className="btn-ghost px-2 py-1 text-xs" disabled={busy} onClick={() => void run(() => api.clearPolicy(def.key, orgRevision), `${def.key} policy cleared`)}>
              Clear
            </button>
          )}
        </div>
        {error && <p className="mt-1 text-[11px] text-red-700">{error}</p>}
      </td>
    </tr>
  )
}
