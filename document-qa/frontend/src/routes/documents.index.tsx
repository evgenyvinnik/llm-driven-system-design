import { createFileRoute } from '@tanstack/react-router'
import { DeletedPanel } from '@/components/library/DeletedPanel'
import { DocumentsTable } from '@/components/library/DocumentsTable'
import { UploadZone } from '@/components/library/UploadZone'
import { ErrorNote, Loading } from '@/components/shared/Loading'
import { usePoll } from '@/lib/use-poll'
import { api } from '@/services/api'

export const Route = createFileRoute('/documents/')({ component: Library })

function Library() {
  const docs = usePoll(() => api.documents(), 2000)
  const deleted = usePoll(() => api.deleted(), 2500)
  const reload = () => {
    docs.reload()
    deleted.reload()
  }
  return (
    <div className="page">
      <div>
        <h1 className="h1">Library</h1>
        <p className="text-sm text-slate-500">Documents you own or that are shared with you. Every list and answer re-checks access on read.</p>
      </div>
      <UploadZone onUploaded={reload} />
      {docs.error && <ErrorNote message={docs.error} />}
      {docs.loading && !docs.data ? <Loading /> : <DocumentsTable documents={docs.data?.documents ?? []} onChange={reload} />}
      <DeletedPanel documents={deleted.data?.documents ?? []} />
    </div>
  )
}
