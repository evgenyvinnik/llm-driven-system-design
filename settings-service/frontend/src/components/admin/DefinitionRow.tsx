import { useState } from 'react'
import { formatValue } from '@/lib/display'
import { ApiError, api } from '@/services/api'
import type { Definition } from '@/types'

const STATUS_TONE = {
  active: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300',
  deprecated: 'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300',
  retired: 'bg-sunken text-muted',
}

function rules(d: Definition): string {
  if (d.type === 'enum') return (d.allowedValues ?? []).join(' | ')
  if (d.type === 'integer') return `${d.minValue ?? '−∞'}…${d.maxValue ?? '∞'}`
  if (d.type === 'string') return d.format ?? (d.maxLength ? `≤ ${d.maxLength} chars` : 'text')
  return 'on | off'
}

interface Props {
  def: Definition
  canEdit: boolean
  replacements: Definition[]
  onChanged: (message: string) => void
}

export function DefinitionRow({ def, canEdit, replacements, onChanged }: Props) {
  const [open, setOpen] = useState(false)
  const [grace, setGrace] = useState(30)
  const [replacedBy, setReplacedBy] = useState('')
  const [error, setError] = useState<string | null>(null)

  async function deprecate() {
    setError(null)
    try {
      await api.deprecate(def.key, grace, replacedBy || null)
      setOpen(false)
      onChanged(`${def.key} deprecated; writes are accepted and ignored for ${grace} days, then rejected`)
    } catch (err) {
      setError(err instanceof ApiError ? err.body.message : 'Outcome unknown; reload to check')
    }
  }

  return (
    <tr className="align-top" data-key={def.key}>
      <td className="px-4 py-2.5">
        <div className="font-mono text-xs text-ink">{def.key}</div>
        <div className="text-[11px] text-muted">{def.label}</div>
      </td>
      <td className="max-w-[180px] px-4 py-2.5 text-xs text-muted">
        {def.type}
        {def.scope === 'org' ? ' · org-scoped' : ''}
        <div className="font-mono text-[11px] text-faint">{rules(def)}</div>
      </td>
      <td className="px-4 py-2.5 text-xs text-ink">{formatValue(def, def.defaultValue)}</td>
      <td className="px-4 py-2.5">
        <span className={`chip ${STATUS_TONE[def.status]}`}>{def.status}</span>
        {def.sunsetAt && (
          <div className="mt-0.5 text-[11px] text-faint">
            {def.status === 'retired' ? 'retired' : 'retires'} {new Date(def.sunsetAt).toLocaleDateString()}
            {def.replacedBy ? ` → ${def.replacedBy}` : ''}
          </div>
        )}
      </td>
      <td className="px-4 py-2.5">
        {canEdit && def.status === 'active' && !open && (
          <button type="button" className="btn-ghost whitespace-nowrap px-2 py-1 text-xs" onClick={() => setOpen(true)}>
            Deprecate
          </button>
        )}
        {open && (
          <div className="flex flex-col gap-1.5 text-xs">
            <label className="flex items-center gap-1 text-muted">
              Grace days
              <input type="number" min={0} max={365} className="field w-16 py-1" value={grace} onChange={(e) => setGrace(Number(e.target.value))} />
            </label>
            <select className="field py-1 text-xs" value={replacedBy} onChange={(e) => setReplacedBy(e.target.value)} aria-label="Replaced by">
              <option value="">No replacement</option>
              {replacements.filter((r) => r.key !== def.key).map((r) => (
                <option key={r.key} value={r.key}>
                  {r.key}
                </option>
              ))}
            </select>
            <div className="flex gap-1">
              <button type="button" className="btn-primary px-2 py-1 text-xs" onClick={() => void deprecate()}>
                Confirm
              </button>
              <button type="button" className="btn-ghost px-2 py-1 text-xs" onClick={() => setOpen(false)}>
                Cancel
              </button>
            </div>
            {error && <p className="text-red-700">{error}</p>}
          </div>
        )}
      </td>
    </tr>
  )
}
