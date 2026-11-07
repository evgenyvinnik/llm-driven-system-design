import { useState } from 'react'
import { optionLabel } from '@/lib/display'
import type { Definition, SettingValue } from '@/types'
import { Toggle } from './Toggle'

interface ControlProps {
  def: Definition
  value: SettingValue | undefined
  disabled: boolean
  onChange: (value: SettingValue) => void
}

const ZONES: string[] = (() => {
  const intl = Intl as unknown as { supportedValuesOf?: (k: string) => string[] }
  return intl.supportedValuesOf ? intl.supportedValuesOf('timeZone') : ['UTC', 'America/New_York', 'America/Los_Angeles', 'Europe/Berlin', 'Europe/London', 'Asia/Tokyo']
})()

/** Picks the control for a definition's type; every control commits a complete value (PATCH sets, never toggles). */
export function SettingControl({ def, value, disabled, onChange }: ControlProps) {
  if (def.type === 'boolean') {
    return <Toggle name={def.key} checked={value === true} disabled={disabled} label={def.label} onChange={onChange} />
  }
  if (def.type === 'enum') {
    return (
      <select name={def.key} aria-label={def.label} className="field min-w-40" value={String(value ?? '')} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
        {(def.allowedValues ?? []).map((v) => (
          <option key={v} value={v}>
            {optionLabel(v)}
          </option>
        ))}
      </select>
    )
  }
  if (def.type === 'integer') {
    const n = typeof value === 'number' ? value : Number(def.defaultValue)
    // A slider only makes sense for a short range; wide ranges (days, minutes) get a number field.
    const short = def.minValue !== null && def.maxValue !== null && def.maxValue - def.minValue <= 200
    return short ? (
      <RangeControl key={String(value)} def={def} value={n} disabled={disabled} onChange={onChange} />
    ) : (
      <NumberControl key={String(value)} def={def} value={n} disabled={disabled} onChange={onChange} />
    )
  }
  if (def.format === 'timezone') {
    const zones = typeof value === 'string' && !ZONES.includes(value) ? [value, ...ZONES] : ZONES
    return (
      <select name={def.key} aria-label={def.label} className="field max-w-56" value={String(value ?? '')} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
        {zones.map((z) => (
          <option key={z} value={z}>
            {z.replace(/_/g, ' ')}
          </option>
        ))}
      </select>
    )
  }
  if (def.format === 'hhmm') {
    return (
      <input
        type="time"
        name={def.key}
        aria-label={def.label}
        className="field w-32"
        value={String(value ?? '')}
        disabled={disabled}
        onChange={(e) => e.target.value && onChange(e.target.value)}
      />
    )
  }
  return <TextControl key={String(value)} def={def} value={String(value ?? '')} disabled={disabled} onChange={onChange} />
}

function RangeControl({ def, value, disabled, onChange }: { def: Definition; value: number; disabled: boolean; onChange: (v: number) => void }) {
  const [draft, setDraft] = useState(value)
  const commit = () => draft !== value && onChange(draft)
  return (
    <div className="flex items-center gap-3">
      <input
        type="range"
        name={def.key}
        aria-label={def.label}
        min={def.minValue ?? 0}
        max={def.maxValue ?? 100}
        step={5}
        value={draft}
        disabled={disabled}
        onChange={(e) => setDraft(Number(e.target.value))}
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={commit}
        className="w-36 accent-accent-600"
      />
      <span className="w-10 text-right font-mono text-sm tabular-nums text-ink">{draft}</span>
    </div>
  )
}

function NumberControl({ def, value, disabled, onChange }: { def: Definition; value: number; disabled: boolean; onChange: (v: number) => void }) {
  const [draft, setDraft] = useState(String(value))
  // Sent as typed: range errors come back from the server as a per-field 422, like any client's would.
  const commit = () => draft !== String(value) && draft.trim() !== '' && onChange(Number(draft))
  return (
    <input
      type="number"
      name={def.key}
      aria-label={def.label}
      className="field w-28 text-right tabular-nums"
      min={def.minValue ?? undefined}
      max={def.maxValue ?? undefined}
      value={draft}
      disabled={disabled}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && commit()}
    />
  )
}

function TextControl({ def, value, disabled, onChange }: { def: Definition; value: string; disabled: boolean; onChange: (v: string) => void }) {
  const [draft, setDraft] = useState(value)
  const commit = () => draft !== value && onChange(draft)
  return (
    <div className="flex flex-col items-end gap-1">
      <input
        type="text"
        name={def.key}
        aria-label={def.label}
        className="field w-64"
        value={draft}
        disabled={disabled}
        placeholder="What's your status?"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && commit()}
      />
      {def.maxLength !== null && (
        <span className={`text-[11px] ${[...draft].length > def.maxLength ? 'text-red-600' : 'text-faint'}`}>
          {[...draft].length}/{def.maxLength}
        </span>
      )}
    </div>
  )
}
