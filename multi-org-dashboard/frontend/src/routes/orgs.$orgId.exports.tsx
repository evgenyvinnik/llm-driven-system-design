import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { ModuleGate } from '@/components/access'
import { ErrorNote, Loading, PageHeader, StatusBadge } from '@/components/shared'
import { useOrg } from '@/hooks/useOrg'
import { bytes, number, timeAgo } from '@/lib/format'
import { keys } from '@/lib/keys'
import { api } from '@/services/api'
import type { ExportJob } from '@/types'

export const Route = createFileRoute('/orgs/$orgId/exports')({
  component: () => (
    <ModuleGate module="exports">
      <ExportsPage />
    </ModuleGate>
  ),
})

function describeFilters(job: ExportJob): string {
  const parts = Object.entries(job.query).map(([k, v]) => `${k}: ${v}`)
  return parts.length ? parts.join(' · ') : 'All conversations'
}

function Progress({ job }: { job: ExportJob }) {
  const pct = job.totalRows ? Math.round((job.processedRows / job.totalRows) * 100) : 0
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-32 overflow-hidden rounded-full bg-slate-200">
        <div className="h-full bg-brand-600 transition-all" style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs text-slate-500">
        {number(job.processedRows)} / {job.totalRows === null ? '…' : number(job.totalRows)}
      </span>
    </div>
  )
}

function ExportsPage() {
  const { orgId, manifest } = useOrg()
  const qc = useQueryClient()
  const { data, error, isPending } = useQuery({ queryKey: keys.exports(orgId), queryFn: ({ signal }) => api.exports(orgId, signal) })
  const cancel = useMutation({
    mutationFn: (id: string) => api.cancelExport(orgId, id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.exports(orgId) }),
  })
  return (
    <div className="max-w-5xl">
      <PageHeader
        title="Exports"
        description={`${manifest.role === 'admin' ? 'All exports in this organization' : 'Your exports'}. Start one from Conversations; files are checked against your access again when downloaded.`}
      />
      {isPending && <Loading />}
      {error && <ErrorNote error={error} />}
      {data && (
        <table className="card w-full overflow-hidden">
          <thead className="bg-slate-50">
            <tr><th className="th">Started</th><th className="th">Filters</th><th className="th">By</th><th className="th">Status</th><th className="th">Progress</th><th className="th" /></tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {data.exports.length === 0 && (
              <tr><td className="td text-slate-500" colSpan={6}>No exports yet.</td></tr>
            )}
            {data.exports.map((job) => (
              <tr key={job.id} data-export={job.id}>
                <td className="td text-slate-500">{timeAgo(job.createdAt)}</td>
                <td className="td text-xs">{describeFilters(job)}</td>
                <td className="td">{job.createdByName}</td>
                <td className="td"><StatusBadge status={job.status} /></td>
                <td className="td">
                  {job.status === 'completed' ? (
                    <span className="text-xs text-slate-500">{number(job.totalRows ?? 0)} rows · {bytes(job.fileBytes)}</span>
                  ) : job.status === 'failed' || job.status === 'cancelled' ? (
                    <span className="text-xs text-slate-500">{job.errorMessage ?? job.errorCode}</span>
                  ) : (
                    <Progress job={job} />
                  )}
                </td>
                <td className="td text-right">
                  {job.status === 'completed' && <a className="btn-secondary" href={api.downloadUrl(orgId, job.id)}>Download</a>}
                  {(job.status === 'queued' || job.status === 'running') && !manifest.readOnly && (
                    <button className="btn-ghost" onClick={() => cancel.mutate(job.id)}>Cancel</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
