import { Link } from '@tanstack/react-router'
import { useState } from 'react'
import { ReplayIcon } from '@/components/icons'
import { ScopeChip, StatusChip } from '@/components/shared/Chips'
import { Empty } from '@/components/shared/Loading'
import { ago, bytes } from '@/lib/format'
import { ApiError, api } from '@/services/api'
import type { DocumentItem } from '@/types'
import { StagePills } from './StagePills'

export function DocumentsTable({ documents, onChange }: { documents: DocumentItem[]; onChange: () => void }) {
  if (documents.length === 0) return <Empty>No documents yet. Drop a file above to add one.</Empty>
  return (
    <div className="card overflow-x-auto">
      <table className="w-full" aria-label="Documents">
        <thead className="border-b border-slate-200 bg-slate-50">
          <tr>
            <th className="th">Document</th>
            <th className="th">Owner</th>
            <th className="th">Access</th>
            <th className="th">Version</th>
            <th className="th">Status</th>
            <th className="th">Pipeline (latest version)</th>
            <th className="th">Updated</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {documents.map((d) => (
            <DocumentRow key={d.id} doc={d} onChange={onChange} />
          ))}
        </tbody>
      </table>
    </div>
  )
}

function DocumentRow({ doc, onChange }: { doc: DocumentItem; onChange: () => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const pending = doc.currentVersionNo !== null && doc.latestVersionNo > doc.currentVersionNo
  const failedLatest = doc.latestVersionStatus === 'failed'

  async function retry() {
    setBusy(true)
    setError(null)
    try {
      await api.retry(doc.id)
      onChange()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Retry failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <tr className="hover:bg-slate-50">
      <td className="td">
        <Link to="/documents/$documentId" params={{ documentId: doc.id }} search={{}} className="font-medium text-slate-900 hover:text-accent-700">
          {doc.title}
        </Link>
        <div className="text-xs text-slate-500">
          {doc.filename ?? '—'} · {bytes(doc.sizeBytes)}
          {doc.chunkCount !== null && ` · ${doc.chunkCount} chunks`}
        </div>
        {failedLatest && (doc.latestVersionFailure || doc.failureReason) && (
          <div className="mt-1 max-w-md text-xs text-rose-800">{doc.latestVersionFailure ?? doc.failureReason}</div>
        )}
        {error && <div className="mt-1 text-xs text-rose-800">{error}</div>}
      </td>
      <td className="td">{doc.isOwner ? 'You' : doc.ownerName}</td>
      <td className="td">
        <ScopeChip scope={doc.scope} groupName={doc.groupName} />
      </td>
      <td className="td num">
        {doc.currentVersionNo !== null ? `v${doc.currentVersionNo}` : '—'}
        {pending && (
          <div className="text-xs text-indigo-700">
            v{doc.latestVersionNo} {doc.latestVersionStatus === 'failed' ? 'failed' : 'processing'}
          </div>
        )}
      </td>
      <td className="td">
        <StatusChip status={doc.status} />
        {failedLatest && doc.isOwner && (
          <button type="button" className="btn-ghost mt-1 !px-1.5 !py-0.5 text-xs" onClick={() => void retry()} disabled={busy}>
            <ReplayIcon className="h-3 w-3" /> Retry
          </button>
        )}
      </td>
      <td className="td">
        <StagePills stages={doc.stages} />
      </td>
      <td className="td text-xs text-slate-500">{ago(doc.updatedAt)}</td>
    </tr>
  )
}
