import { Link, createFileRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { ChunksTable } from '@/components/detail/ChunksTable'
import { EventsList } from '@/components/detail/EventsList'
import { JobTimeline } from '@/components/detail/JobTimeline'
import { OwnerControls } from '@/components/detail/OwnerControls'
import { TextViewer } from '@/components/detail/TextViewer'
import { VersionsList } from '@/components/detail/VersionsList'
import { ScopeChip, StatusChip } from '@/components/shared/Chips'
import { ErrorNote, Loading } from '@/components/shared/Loading'
import { usePoll } from '@/lib/use-poll'
import { api } from '@/services/api'

interface DetailSearch {
  version?: string
  start?: number
  end?: number
}

const toInt = (v: unknown): number | undefined => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number.parseInt(v, 10) : NaN
  return Number.isFinite(n) && n >= 0 ? n : undefined
}

export const Route = createFileRoute('/documents/$documentId')({
  validateSearch: (s: Record<string, unknown>): DetailSearch => ({
    version: typeof s.version === 'string' && s.version ? s.version : undefined,
    start: toInt(s.start),
    end: toInt(s.end),
  }),
  component: DocumentPage,
})

function DocumentPage() {
  const { documentId } = Route.useParams()
  const search = Route.useSearch()
  const detail = usePoll(() => api.document(documentId), 2000, [documentId])
  // A version's text never changes; refetch only when the viewed (or current) version does.
  const text = usePoll(() => api.text(documentId, search.version), 60_000, [documentId, search.version, detail.data?.document.currentVersionNo ?? null])
  const chunks = usePoll(() => api.chunks(documentId, search.version), 2500, [documentId, search.version])
  const fromUrl = search.start !== undefined && search.end !== undefined ? { start: search.start, end: search.end } : null
  const [picked, setPicked] = useState<{ id: string; start: number; end: number } | null>(null)
  const viewing = text.data?.versionId ?? null
  // A picked chunk belongs to one version; drop it when the viewed version changes (e.g. after a switch).
  useEffect(() => setPicked(null), [search.start, search.end, search.version, viewing])

  // A 404 while viewing means the document was just deleted or unshared: stop showing the stale copy.
  if (detail.error && (!detail.data || detail.errorStatus === 404)) {
    return (
      <div className="page">
        <ErrorNote message={`${detail.error}. It may have been deleted, or it is no longer shared with you.`} />
        <Link to="/documents" className="text-sm text-accent-700 hover:underline">
          Back to the library
        </Link>
      </div>
    )
  }
  if (!detail.data) return <Loading />
  const { document: doc, versions, jobs, events } = detail.data
  const highlight = picked ? { start: picked.start, end: picked.end } : fromUrl

  return (
    <div className="page !max-w-7xl">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <Link to="/documents" className="text-xs text-slate-500 hover:text-accent-700">
            ← Library
          </Link>
          <h1 className="h1 mt-1">{doc.title}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-slate-600">
            <StatusChip status={doc.status} />
            <ScopeChip scope={doc.scope} groupName={doc.groupName} />
            <span>owner {doc.isOwner ? 'you' : doc.ownerName}</span>
            <span>· serving {doc.currentVersionNo !== null ? `v${doc.currentVersionNo}` : 'no version yet'}</span>
            {doc.latestVersionNo !== doc.currentVersionNo && <span className="text-indigo-700">· v{doc.latestVersionNo} {doc.latestVersionStatus}</span>}
          </div>
          {doc.failureReason && <p className="mt-1 text-sm text-rose-800">{doc.failureReason}</p>}
        </div>
        {doc.isOwner && <OwnerControls doc={doc} onChange={detail.reload} />}
      </div>
      <div className="grid gap-5 lg:grid-cols-2">
        <TextViewer text={text.data} highlight={highlight} />
        <ChunksTable chunks={chunks.data?.chunks ?? []} selected={picked?.id ?? null} onSelect={(c) => setPicked({ id: c.id, start: c.charStart, end: c.charEnd })} />
      </div>
      <div className="grid gap-5 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <JobTimeline jobs={jobs} versions={versions} />
        <div className="space-y-5">
          <VersionsList documentId={doc.id} versions={versions} currentNo={doc.currentVersionNo} viewing={text.data?.versionId ?? null} />
          <EventsList events={events} />
        </div>
      </div>
    </div>
  )
}
