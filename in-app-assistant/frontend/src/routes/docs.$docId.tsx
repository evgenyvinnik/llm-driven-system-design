import { Link, createFileRoute } from '@tanstack/react-router'
import { useCallback, useEffect, useState } from 'react'
import { ParagraphBlock } from '@/components/docs/ParagraphBlock'
import { SharePanel } from '@/components/docs/SharePanel'
import { ChevronLeftIcon } from '@/components/icons'
import { ErrorNote, Loading } from '@/components/shared/Loading'
import { ApiError, api } from '@/services/api'
import { useWorkspaceStore } from '@/stores/workspace-store'
import type { DocumentDetail } from '@/types'

export const Route = createFileRoute('/docs/$docId')({
  validateSearch: (search: Record<string, unknown>): { p?: string } => ({ p: typeof search.p === 'string' ? search.p : undefined }),
  component: DocEditor,
})

function DocEditor() {
  const { docId } = Route.useParams()
  const { p: highlight } = Route.useSearch()
  const revision = useWorkspaceStore((s) => s.revision)
  const doc = useWorkspaceStore((s) => s.openDocument)
  const selection = useWorkspaceStore((s) => s.selection)
  const { setOpenDocument, setSelection } = useWorkspaceStore.getState()
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(() => {
    api.document(docId).then((r) => setOpenDocument(r.document)).catch((e) => setError(e.message))
  }, [docId, setOpenDocument])

  useEffect(() => {
    setError(null)
    reload()
  }, [reload, revision])
  useEffect(() => () => setOpenDocument(null), [setOpenDocument])
  useEffect(() => {
    if (highlight && doc) document.getElementById(highlight)?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [highlight, doc?.id, doc?.version, doc])

  if (error) return <ErrorNote message={error} />
  if (!doc || doc.id !== docId) return <Loading />
  const editable = doc.role !== 'viewer'

  const select = (id: string, extend: boolean) => {
    if (!extend || selection.length === 0) return setSelection(selection.length === 1 && selection[0] === id ? [] : [id])
    const ids = doc.paragraphs.map((p) => p.id)
    const [a, b] = [ids.indexOf(selection[0]), ids.indexOf(id)].sort((x, y) => x - y)
    setSelection(ids.slice(a, b + 1))
  }
  const update = (next: DocumentDetail) => setOpenDocument(next)

  return (
    <div className="flex h-full">
      <div className="flex-1 overflow-y-auto">
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-slate-200 bg-white/95 px-6 py-2 backdrop-blur">
          <Link to="/docs" className="btn-ghost px-2"><ChevronLeftIcon /> Documents</Link>
          <div className="flex items-center gap-3 text-xs text-slate-400">
            <span>v{doc.version}</span>
            <span>{doc.owner}</span>
            {!editable && <span className="chip bg-amber-50 text-amber-700">View only</span>}
            <span>Click to select · Shift-click for a range · Double-click to edit</span>
          </div>
        </div>
        <div className="mx-auto max-w-2xl px-14 py-8">
          {doc.paragraphs.map((p) => (
            <ParagraphBlock
              key={p.id}
              paragraph={p}
              selected={selection.includes(p.id)}
              highlighted={p.id === highlight}
              editable={editable}
              onSelect={(extend) => select(p.id, extend)}
              onSave={async (text) => {
                try {
                  update((await api.editParagraph(doc.id, p.id, text, doc.version)).document)
                } catch (err) {
                  // Someone (or the assistant) changed the doc meanwhile: reload rather than overwrite.
                  if (err instanceof ApiError && err.code === 'VERSION_CONFLICT') reload()
                  else throw err
                }
              }}
              onDecide={(decision) => void api.decideSuggestion(doc.id, p.id, decision).then((r) => update(r.document))}
            />
          ))}
        </div>
      </div>
      {doc.role === 'owner' && (
        <div className="w-64 shrink-0 border-l border-slate-200 p-3">
          <SharePanel doc={doc} onChange={update} />
        </div>
      )}
    </div>
  )
}
