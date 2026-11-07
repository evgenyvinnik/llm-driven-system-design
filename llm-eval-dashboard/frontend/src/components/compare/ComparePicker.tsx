import type { RunListItem, Scorer } from '@/types'

export function ComparePicker({ runs, scorers, a, b, scorer, onChange }: { runs: RunListItem[]; scorers: Scorer[]; a?: string; b?: string; scorer?: string; onChange: (next: { a?: string; b?: string; scorer?: string }) => void }) {
  const runOption = (r: RunListItem) => (
    <option key={r.id} value={r.id}>
      {`${r.name} · ${r.dataset.name} v${r.dataset.version} · ${r.prompt.name} v${r.prompt.version} · ${r.modelConfig.name} ×${r.samplesPerCase}`}
    </option>
  )
  return (
    <div className="card grid grid-cols-1 gap-3 p-4 md:grid-cols-[1fr_1fr_16rem]">
      <label className="block">
        <span className="label">Run A (baseline)</span>
        <select className="input" value={a ?? ''} onChange={(e) => onChange({ a: e.target.value || undefined, b, scorer })} aria-label="Run A">
          <option value="">Choose…</option>
          {runs.map(runOption)}
        </select>
      </label>
      <label className="block">
        <span className="label">Run B (candidate)</span>
        <select className="input" value={b ?? ''} onChange={(e) => onChange({ a, b: e.target.value || undefined, scorer })} aria-label="Run B">
          <option value="">Choose…</option>
          {runs.map(runOption)}
        </select>
      </label>
      <label className="block">
        <span className="label">Scorer</span>
        <select className="input" value={scorer ?? ''} onChange={(e) => onChange({ a, b, scorer: e.target.value || undefined })} aria-label="Scorer">
          <option value="">Choose…</option>
          {scorers.filter((s) => s.kind !== 'human').map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </label>
    </div>
  )
}
