import { Empty } from '@/components/shared/Loading'
import { PurgeProgress } from '@/components/shared/PurgeProgress'
import { ago, shortId } from '@/lib/format'
import type { OpsOverview } from '@/types'

export function PurgeBacklog({ items }: { items: OpsOverview['purgeBacklog'] }) {
  return (
    <section className="card" aria-label="Purge backlog">
      <div className="border-b border-slate-100 px-4 py-2">
        <h2 className="panel-title">Deleted documents and purge progress</h2>
      </div>
      {items.length === 0 ? (
        <Empty>No deleted documents.</Empty>
      ) : (
        <ul className="divide-y divide-slate-100">
          {items.map((d) => (
            <li key={d.documentId} className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-4 px-4 py-2">
              <div className="text-xs">
                <div className="font-mono text-slate-700">{shortId(d.documentId)}</div>
                <div className="text-slate-500">
                  {d.orgName} · deleted {ago(d.deletedAt)}
                </div>
              </div>
              <PurgeProgress purge={d.purge} completedAt={d.purgeCompletedAt} />
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
