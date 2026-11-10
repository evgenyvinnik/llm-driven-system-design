/** The caller's deleted documents: gone from the library and from answers at once; this shows the purge catching up. */
import { PurgeProgress } from '@/components/shared/PurgeProgress'
import { ago } from '@/lib/format'
import type { DeletedItem } from '@/types'

export function DeletedPanel({ documents }: { documents: DeletedItem[] }) {
  if (documents.length === 0) return null
  return (
    <section aria-label="Recently deleted" className="card p-4">
      <h2 className="panel-title">Recently deleted</h2>
      <p className="mb-3 mt-1 text-xs text-slate-500">
        A tombstone hides a document from the library, retrieval, citations and cached answers the moment you delete it. The purge then removes its
        cached answers, index entries, embeddings, chunks and every version&apos;s file, and records when it finished.
      </p>
      <ul className="divide-y divide-slate-100">
        {documents.map((d) => (
          <li key={d.id} className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-4 py-2">
            <div>
              <div className="text-sm font-medium text-slate-700 line-through decoration-slate-400">{d.title}</div>
              <div className="text-xs text-slate-500">deleted {ago(d.deletedAt)}</div>
            </div>
            <PurgeProgress purge={d.purge} completedAt={d.purgeCompletedAt} />
          </li>
        ))}
      </ul>
    </section>
  )
}
