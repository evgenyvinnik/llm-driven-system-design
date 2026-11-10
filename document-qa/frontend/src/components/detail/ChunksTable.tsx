import { CheckIcon } from '@/components/icons'
import { Empty } from '@/components/shared/Loading'
import type { ChunkItem } from '@/types'

export function ChunksTable({ chunks, selected, onSelect }: { chunks: ChunkItem[]; selected: string | null; onSelect: (c: ChunkItem) => void }) {
  return (
    <section className="card" aria-label="Chunk list">
      <div className="border-b border-slate-100 px-4 py-2">
        <h2 className="panel-title">Chunks ({chunks.length})</h2>
        <p className="text-xs text-slate-500">Offsets index into the extracted text; click a row to highlight its span.</p>
      </div>
      {chunks.length === 0 ? (
        <Empty>No chunks for this version (not chunked yet, or retired).</Empty>
      ) : (
        <div className="max-h-[32rem] overflow-y-auto">
          <table className="w-full" aria-label="Chunks">
            <thead className="sticky top-0 border-b border-slate-200 bg-slate-50">
              <tr>
                <th className="th">#</th>
                <th className="th">Chars</th>
                <th className="th">Heading</th>
                <th className="th">Tokens</th>
                <th className="th" title="Embedded / indexed">E / I</th>
                <th className="th">Text</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {chunks.map((c) => (
                <tr key={c.id} onClick={() => onSelect(c)} className={`cursor-pointer ${selected === c.id ? 'bg-amber-50' : 'hover:bg-slate-50'}`}>
                  <td className="td num">{c.ordinal}</td>
                  <td className="td num whitespace-nowrap text-xs">
                    {c.charStart}–{c.charEnd}
                  </td>
                  <td className="td max-w-[8rem] truncate text-xs">{c.heading ?? '—'}</td>
                  <td className="td num text-xs">{c.tokenCount}</td>
                  <td className="td whitespace-nowrap">
                    <Tick on={c.embedded} label="embedded" /> <Tick on={c.indexed} label="indexed" />
                  </td>
                  <td className="td max-w-xs truncate text-xs text-slate-600" title={c.text}>
                    {c.text}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

function Tick({ on, label }: { on: boolean; label: string }) {
  return on ? <CheckIcon className="inline h-3.5 w-3.5 text-emerald-600" title={label} /> : <span className="text-slate-300" title={`not ${label}`}>·</span>
}
