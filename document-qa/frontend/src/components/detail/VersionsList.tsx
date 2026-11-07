import { Link } from '@tanstack/react-router'
import { StatusChip } from '@/components/shared/Chips'
import { ago, bytes } from '@/lib/format'
import type { VersionItem } from '@/types'

export function VersionsList({ documentId, versions, currentNo, viewing }: { documentId: string; versions: VersionItem[]; currentNo: number | null; viewing: string | null }) {
  return (
    <section className="card p-4" aria-label="Versions">
      <h2 className="panel-title mb-2">Versions</h2>
      <ul className="space-y-2">
        {versions.map((v) => (
          <li key={v.id} className={`rounded-md border px-3 py-2 text-sm ${viewing === v.id ? 'border-accent-200 bg-accent-50' : 'border-slate-200'}`}>
            <div className="flex items-center gap-2">
              <Link to="/documents/$documentId" params={{ documentId }} search={{ version: v.id }} className="font-semibold text-slate-800 hover:text-accent-700">
                v{v.versionNo}
              </Link>
              <StatusChip status={v.status} />
              {currentNo === v.versionNo && <span className="chip bg-accent-100 text-accent-700">current</span>}
              <span className="flex-1" />
              <span className="text-xs text-slate-500">{ago(v.createdAt)}</span>
            </div>
            <div className="mt-1 text-xs text-slate-500">
              {v.filename} · {bytes(v.sizeBytes)} · {v.chunkCount ?? '—'} chunks ({v.liveChunks} live) · sha256 {v.contentHash.slice(0, 10)}
            </div>
            {v.failureReason && <div className="mt-1 text-xs text-rose-800">{v.failureReason}</div>}
            <div className="mt-0.5 text-xs text-slate-400">
              {v.activatedAt && `activated ${ago(v.activatedAt)}`}
              {v.supersededAt && ` · superseded ${ago(v.supersededAt)}`}
              {v.retiredAt && ` · chunks retired ${ago(v.retiredAt)}`}
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}
