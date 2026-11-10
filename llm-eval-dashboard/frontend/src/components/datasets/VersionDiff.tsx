import { useEffect, useState } from 'react'
import { Loading } from '@/components/shared/Loading'
import { preview } from '@/lib/format'
import { api } from '@/services/api'
import type { CaseDiff } from '@/types'

/** Case-level diff between two versions, by case key; modified cases show which fields changed. */
export function VersionDiff({ datasetId, from, to }: { datasetId: string; from: number; to: number }) {
  const [diff, setDiff] = useState<CaseDiff | null>(null)
  useEffect(() => {
    setDiff(null)
    void api.datasetDiff(datasetId, from, to).then((r) => setDiff(r.diff))
  }, [datasetId, from, to])
  if (!diff) return <Loading label="Diffing…" />
  return (
    <div className="card space-y-3 p-4" aria-label="Version diff">
      <div className="flex flex-wrap gap-2 text-xs">
        <span className="chip bg-emerald-100 text-emerald-800">+{diff.added.length} added</span>
        <span className="chip bg-rose-100 text-rose-800">−{diff.removed.length} removed</span>
        <span className="chip bg-amber-100 text-amber-800">~{diff.modified.length} modified</span>
        <span className="chip bg-slate-100 text-slate-600">{diff.unchanged} unchanged</span>
      </div>
      <ul className="space-y-1.5 text-xs">
        {diff.modified.map((m) => (
          <li key={m.caseKey} className="rounded border border-amber-200 bg-amber-50 px-2 py-1.5">
            <span className="font-mono font-semibold">{m.caseKey}</span> changed {m.fields.join(', ')}
            {m.fields.includes('reference') && (
              <span>
                : reference <span className="font-mono line-through">{preview(m.from.reference, 40)}</span> → <span className="font-mono font-semibold">{preview(m.to.reference, 40)}</span>
              </span>
            )}
            {m.fields.includes('tags') && <span className="text-slate-500"> · tags [{m.from.tags.join(', ')}] → [{m.to.tags.join(', ')}]</span>}
          </li>
        ))}
        {diff.added.map((c) => (
          <li key={c.caseKey} className="rounded border border-emerald-200 bg-emerald-50 px-2 py-1.5">
            <span className="font-mono font-semibold">+ {c.caseKey}</span> {preview(Object.values(c.input)[0], 100)} → <span className="font-mono">{preview(c.reference, 30)}</span>
          </li>
        ))}
        {diff.removed.map((c) => (
          <li key={c.caseKey} className="rounded border border-rose-200 bg-rose-50 px-2 py-1.5">
            <span className="font-mono font-semibold">− {c.caseKey}</span> {preview(Object.values(c.input)[0], 100)}
          </li>
        ))}
      </ul>
      <p className="text-[11px] text-slate-500">A run on v{from} and a run on v{to} can't be paired case by case: the comparison view restricts them to the unchanged cases and marks the result indicative only.</p>
    </div>
  )
}
