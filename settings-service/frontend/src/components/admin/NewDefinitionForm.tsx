import { useState, type FormEvent } from 'react'
import { PlusIcon } from '@/components/icons'
import { ApiError, api } from '@/services/api'
import type { FieldError, SettingType } from '@/types'

const CATEGORIES = ['notifications', 'appearance', 'privacy', 'regional', 'profile', 'security']

function parseDefault(type: SettingType, raw: string): boolean | number | string {
  if (type === 'boolean') return raw === 'true'
  if (type === 'integer') return Number(raw)
  return raw
}

/** Adds a definition at runtime. No user rows are written: everyone resolves to the default immediately. */
export function NewDefinitionForm({ onCreated }: { onCreated: (key: string) => void }) {
  const [key, setKey] = useState('notifications.weekly_report')
  const [label, setLabel] = useState('Weekly activity report')
  const [type, setType] = useState<SettingType>('boolean')
  const [category, setCategory] = useState('notifications')
  const [def, setDef] = useState('true')
  const [options, setOptions] = useState('')
  const [range, setRange] = useState('1,10')
  const [errors, setErrors] = useState<FieldError[]>([])
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setErrors([])
    const [min, max] = range.split(',').map((n) => Number(n.trim()))
    const input: Record<string, unknown> = { key, label, type, category, defaultValue: parseDefault(type, def), description: 'Added from the catalog page.' }
    if (type === 'enum') input.allowedValues = options.split(',').map((o) => o.trim()).filter(Boolean)
    if (type === 'integer') Object.assign(input, { minValue: min, maxValue: max })
    if (type === 'string') input.maxLength = 120
    try {
      await api.createDefinition(input)
      onCreated(key)
    } catch (err) {
      if (err instanceof ApiError) setErrors((err.body.fields as FieldError[] | undefined) ?? [{ key: '(form)', code: err.body.code, message: err.body.message }])
      else setErrors([{ key: '(form)', code: 'UNKNOWN', message: 'Outcome unknown; reload the catalog to check' }])
    } finally {
      setBusy(false)
    }
  }

  const input = 'field w-full'
  return (
    <form onSubmit={submit} className="card space-y-3 p-4" aria-label="Add a setting">
      <h2 className="text-sm font-semibold text-ink">Add a setting</h2>
      <label className="block text-xs text-muted">
        Key
        <input name="key" className={`${input} font-mono`} value={key} onChange={(e) => setKey(e.target.value)} />
      </label>
      <label className="block text-xs text-muted">
        Label
        <input name="label" className={input} value={label} onChange={(e) => setLabel(e.target.value)} />
      </label>
      <div className="grid grid-cols-2 gap-2">
        <label className="block text-xs text-muted">
          Type
          <select name="type" className={input} value={type} onChange={(e) => setType(e.target.value as SettingType)}>
            {['boolean', 'enum', 'integer', 'string'].map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </label>
        <label className="block text-xs text-muted">
          Category
          <select name="category" className={input} value={category} onChange={(e) => setCategory(e.target.value)}>
            {CATEGORIES.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </label>
      </div>
      {type === 'enum' && (
        <label className="block text-xs text-muted">
          Allowed values (comma-separated)
          <input name="allowedValues" className={input} value={options} onChange={(e) => setOptions(e.target.value)} placeholder="low, medium, high" />
        </label>
      )}
      {type === 'integer' && (
        <label className="block text-xs text-muted">
          Range (min,max)
          <input name="range" className={input} value={range} onChange={(e) => setRange(e.target.value)} />
        </label>
      )}
      <label className="block text-xs text-muted">
        Default
        <input name="defaultValue" className={input} value={def} onChange={(e) => setDef(e.target.value)} />
      </label>
      {errors.length > 0 && (
        <ul className="space-y-0.5 text-xs text-red-700" role="alert">
          {errors.map((er, i) => (
            <li key={i}>
              <span className="font-mono">{er.key}</span>: {er.message}
            </li>
          ))}
        </ul>
      )}
      <button type="submit" className="btn-primary w-full justify-center" disabled={busy}>
        <PlusIcon className="h-4 w-4" /> Add setting
      </button>
    </form>
  )
}
