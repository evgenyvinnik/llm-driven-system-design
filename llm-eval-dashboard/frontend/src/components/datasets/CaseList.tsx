import { Tag } from '@/components/shared/Chips'
import { preview } from '@/lib/format'
import type { DatasetCase } from '@/types'

export function CaseList({ cases }: { cases: DatasetCase[] }) {
  return (
    <div className="card overflow-x-auto">
      <table className="w-full" aria-label="Dataset cases">
        <thead className="border-b border-slate-200 bg-slate-50">
          <tr>
            <th className="th">Key</th>
            <th className="th">Input variables</th>
            <th className="th">Reference</th>
            <th className="th">Tags</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {cases.map((c) => (
            <tr key={c.id}>
              <td className="td font-mono text-xs font-semibold">{c.caseKey}</td>
              <td className="td max-w-md text-xs text-slate-700">
                {Object.entries(c.input).map(([k, v]) => (
                  <div key={k}>
                    <span className="font-mono text-slate-400">{k}:</span> {preview(v, 140)}
                  </div>
                ))}
              </td>
              <td className="td max-w-xs font-mono text-[11px] text-slate-700">{preview(c.reference, 80)}</td>
              <td className="td">
                <div className="flex flex-wrap gap-1">{c.tags.map((t) => <Tag key={t}>{t}</Tag>)}</div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
