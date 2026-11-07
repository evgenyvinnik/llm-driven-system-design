import { Link, createFileRoute } from '@tanstack/react-router'
import { Empty, ErrorNote, Loading } from '@/components/shared/Loading'
import { ago } from '@/lib/format'
import { usePoll } from '@/lib/use-poll'
import { api } from '@/services/api'

export const Route = createFileRoute('/datasets/')({ component: DatasetsPage })

function DatasetsPage() {
  const { data, error, loading } = usePoll(() => api.datasets(), 10_000)
  return (
    <div className="page">
      <div>
        <h1 className="h1">Datasets</h1>
        <p className="text-sm text-slate-500">Versions are immutable: editing a dataset creates a new version, and runs keep pointing at the version they used.</p>
      </div>
      {error && <ErrorNote message={error} />}
      {loading && !data ? (
        <Loading />
      ) : data && data.datasets.length > 0 ? (
        <div className="card overflow-x-auto">
          <table className="w-full" aria-label="Datasets">
            <thead className="border-b border-slate-200 bg-slate-50">
              <tr>
                <th className="th">Dataset</th>
                <th className="th">Head version</th>
                <th className="th">Cases</th>
                <th className="th">Runs</th>
                <th className="th">Updated</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.datasets.map((d) => (
                <tr key={d.id} className="hover:bg-slate-50">
                  <td className="td">
                    <Link to="/datasets/$datasetId" params={{ datasetId: d.id }} className="font-medium text-accent-700 hover:underline">
                      {d.name}
                    </Link>
                    <div className="text-xs text-slate-500">{d.description}</div>
                  </td>
                  <td className="td num">v{d.headVersion}</td>
                  <td className="td num">{d.caseCount}</td>
                  <td className="td num">{d.runs}</td>
                  <td className="td text-xs text-slate-500">{ago(d.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty>No datasets.</Empty>
      )}
    </div>
  )
}
