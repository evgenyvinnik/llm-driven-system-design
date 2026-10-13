import { XIcon } from '@/components/icons'
import type { ModelConfig, ModelInfo, Preset } from '@/types'

interface Props {
  config: ModelConfig
  label?: string
  models: ModelInfo[]
  presets: Preset[]
  onChange: (config: ModelConfig) => void
  onRemove?: () => void
}

export function ConfigCard({ config, label, models, presets, onChange, onRemove }: Props) {
  const model = models.find((m) => m.id === config.model)
  const set = (patch: Partial<ModelConfig>) => onChange({ ...config, ...patch })

  return (
    <div className="card space-y-3 p-3">
      <div className="flex items-center justify-between">
        <span className="panel-title">{label ? `Config ${label}` : 'Model'}</span>
        <div className="flex items-center gap-1">
          <select
            className="rounded border border-slate-200 bg-white px-1.5 py-0.5 text-xs text-slate-600"
            value=""
            onChange={(e) => {
              const preset = presets.find((p) => p.id === e.target.value)
              if (preset) onChange({ ...preset.config })
            }}
            aria-label="Apply preset"
          >
            <option value="">Preset…</option>
            {presets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          {onRemove && (
            <button className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700" onClick={onRemove} aria-label="Remove config">
              <XIcon className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>
      <div>
        <select className="input" value={config.model} onChange={(e) => set({ model: e.target.value })} aria-label="Model">
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label} ({m.id})
            </option>
          ))}
        </select>
        {model && <p className="mt-1 text-xs text-slate-500">{model.description}</p>}
      </div>
      <Slider label="Temperature" min={0} max={2} step={0.1} value={config.temperature} onChange={(temperature) => set({ temperature })} />
      <Slider label="Top P" min={0} max={1} step={0.05} value={config.topP} onChange={(topP) => set({ topP })} />
      <div className="flex items-center justify-between gap-3">
        <label className="text-xs font-medium text-slate-600" htmlFor={`max-tokens-${label ?? 'a'}`}>
          Max tokens
        </label>
        <input
          id={`max-tokens-${label ?? 'a'}`}
          type="number"
          min={1}
          max={model?.maxOutputTokens ?? 4096}
          className="input w-24 text-right tabular-nums"
          value={config.maxTokens}
          onChange={(e) => set({ maxTokens: Math.max(1, Math.min(Number(e.target.value) || 1, model?.maxOutputTokens ?? 4096)) })}
        />
      </div>
    </div>
  )
}

function Slider(props: { label: string; min: number; max: number; step: number; value: number; onChange: (v: number) => void }) {
  return (
    <div>
      <div className="flex items-center justify-between text-xs">
        <span className="font-medium text-slate-600">{props.label}</span>
        <span className="tabular-nums text-slate-800">{props.value.toFixed(2)}</span>
      </div>
      <input
        type="range"
        className="w-full accent-accent-600"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        onChange={(e) => props.onChange(Number(e.target.value))}
        aria-label={props.label}
      />
    </div>
  )
}
