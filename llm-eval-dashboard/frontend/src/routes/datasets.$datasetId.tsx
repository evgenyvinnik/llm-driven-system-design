import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { CaseList } from '@/components/datasets/CaseList'
import { NewVersionEditor } from '@/components/datasets/NewVersionEditor'
import { VersionDiff } from '@/components/datasets/VersionDiff'
import { ErrorNote, Loading } from '@/components/shared/Loading'
import { ago } from '@/lib/format'
import { usePoll } from '@/lib/use-poll'
import { api } from '@/services/api'
import type { DatasetCase } from '@/types'

export const Route = createFileRoute('/datasets/$datasetId')({ component: DatasetPage })

function DatasetPage() {
  const { datasetId } = Route.useParams()
  const { data, error, reload } = usePoll(() => api.dataset(datasetId), 15_000, [datasetId])
  const [version, setVersion] = useState<number | null>(null)
  const [cases, setCases] = useState<DatasetCase[] | null>(null)
  const [editing, setEditing] = useState(false)
  const [editBase, setEditBase] = useState(0)
  const d = data?.dataset
  const selected = version ?? d?.headVersion ?? null

  useEffect(() => {
    if (selected === null) return
    setCases(null)
    void api.datasetCases(datasetId, selected).then((r) => setCases(r.cases))
  }, [datasetId, selected])

  if (error && !d) return <div className="page"><ErrorNote message={error} /></div>
  if (!d || selected === null) return <div className="page"><Loading /></div>
  return (
    <div className="page max-w-7xl">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="h1">{d.name}</h1>
          <p className="text-sm text-slate-500">{d.description}</p>
        </div>
        {!editing && selected === d.headVersion && (
          <button
            type="button"
            className="btn-primary"
            disabled={!cases}
            onClick={() => {
              // Pin the version being edited, so a poll that moves the head neither swaps the cases nor the base.
              setVersion(selected)
              setEditBase(d.headVersion)
              setEditing(true)
            }}
          >
            Edit → new version
          </button>
        )}
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-4">
        <div className="card divide-y divide-slate-100" aria-label="Versions">
          {d.versions.map((v) => (
            <button key={v.id} type="button" onClick={() => setVersion(v.version)} className={`block w-full px-3 py-2 text-left ${v.version === selected ? 'bg-accent-50' : 'hover:bg-slate-50'}`}>
              <div className="flex items-center justify-between text-sm font-semibold">
                v{v.version} {v.version === d.headVersion && <span className="chip bg-accent-100 text-accent-700">head</span>}
              </div>
              <div className="text-xs text-slate-600">{v.message}</div>
              <div className="text-[11px] text-slate-400">
                {v.caseCount} cases · {v.runs} runs · {v.createdBy} {ago(v.createdAt)}
              </div>
              <div className="font-mono text-[10px] text-slate-400">{v.contentHash.slice(0, 12)}</div>
            </button>
          ))}
        </div>
        <div className="space-y-4 lg:col-span-3">
          {editing && cases ? (
            <NewVersionEditor
              datasetId={datasetId}
              baseVersion={editBase}
              cases={cases}
              onCancel={() => setEditing(false)}
              onSaved={(v) => {
                setEditing(false)
                setVersion(v)
                reload()
              }}
            />
          ) : (
            selected > 1 && <VersionDiff datasetId={datasetId} from={selected - 1} to={selected} />
          )}
          {cases ? <CaseList cases={cases} /> : <Loading label="Loading cases…" />}
        </div>
      </div>
    </div>
  )
}
