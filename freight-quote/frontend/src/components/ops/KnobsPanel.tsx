import { useState } from 'react'
import { DEPENDENCY_LABEL } from '@/lib/format'
import { api } from '@/services/api'
import { DEPENDENCIES, type Dependency, type Knobs } from '@/types'

const PRESETS: { label: string; patch: Partial<Knobs> }[] = [
  { label: 'Healthy', patch: {} },
  { label: 'p99 → 8 s', patch: { tailPct: 5, tailMs: 8_000 } },
  { label: 'Slow (2.5 s)', patch: { latencyMs: 2_500, tailPct: 0 } },
  { label: '50% errors', patch: { errorRate: 50 } },
  { label: 'Down', patch: { down: true } },
]

/** Fault injection for the mock dependencies (latency, tail, errors, outages, worker pool). */
export function KnobsPanel({ knobs, defaults, onChange }: { knobs: Record<Dependency, Knobs>; defaults: Record<Dependency, Knobs>; onChange: () => void }) {
  const [dep, setDep] = useState<Dependency>('capacity')
  const k = knobs[dep]
  const apply = async (patch: Partial<Knobs>) => {
    await api.setKnobs(dep, patch)
    onChange()
  }
  const field = (name: keyof Knobs, label: string, max: number) => (
    <label className="block text-xs">
      <span className="text-slate-500">{label}</span>
      <input
        type="number"
        min={0}
        max={max}
        className="input mt-0.5"
        defaultValue={k[name] as number}
        key={`${dep}-${name}-${String(k[name])}`}
        onBlur={(e) => Number(e.target.value) !== k[name] && void apply({ [name]: Number(e.target.value) })}
      />
    </label>
  )
  return (
    <section className="card p-4" aria-label="Dependency knobs">
      <div className="mb-3 flex items-center justify-between">
        <div className="panel-title">Dependency knobs</div>
        <button type="button" className="btn-ghost text-xs" onClick={() => void api.resetKnobs().then(onChange)}>
          Reset all
        </button>
      </div>
      <div className="mb-3 flex flex-wrap gap-1">
        {DEPENDENCIES.map((d) => (
          <button key={d} type="button" onClick={() => setDep(d)} className={`chip ${d === dep ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-700 hover:bg-slate-200'}`}>
            {DEPENDENCY_LABEL[d]}
            {knobs[d].down ? ' (down)' : ''}
          </button>
        ))}
      </div>
      <div className="mb-3 flex flex-wrap gap-1.5">
        {PRESETS.map((p) => (
          <button key={p.label} type="button" className="btn-secondary px-2 py-1 text-xs" onClick={() => void apply({ ...defaults[dep], ...p.patch })}>
            {p.label}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-3 gap-2">
        {field('latencyMs', 'Median ms', 60_000)}
        {field('tailPct', 'Tail %', 100)}
        {field('tailMs', 'Tail ms', 60_000)}
        {field('errorRate', 'Errors %', 100)}
        {field('hangRate', 'Hangs %', 100)}
        {field('concurrency', 'Workers', 10_000)}
      </div>
    </section>
  )
}
