import { Link, createFileRoute } from '@tanstack/react-router'
import { VersionChip } from '@/components/shared/Chips'
import { ErrorNote, Loading } from '@/components/shared/Loading'
import { clockDay, reasonLabel } from '@/lib/format'
import { usePolling } from '@/lib/usePolling'
import { api } from '@/services/api'

export const Route = createFileRoute('/plans/')({ component: PlansPage })

function PlansPage() {
  const { data, error } = usePolling(api.plans, 4000)
  const overrides = usePolling(api.overrides, 4000).data?.overrides ?? []
  if (error && !data) return <main className="page"><ErrorNote message={error} /></main>
  if (!data) return <Loading />
  return (
    <main className="page">
      <h1 className="text-lg font-semibold text-slate-900">Plan versions</h1>
      <p className="text-sm text-slate-600">Each version is immutable. A change is a new version with a parent, an author, a reason and the yard state it was built on. Yard state is at v{data.stateVersion}.</p>
      <div className="card overflow-x-auto">
        <table className="w-full" aria-label="Plan versions">
          <thead>
            <tr>
              <th className="th">Version</th>
              <th className="th">Status</th>
              <th className="th">Author</th>
              <th className="th">Reason</th>
              <th className="th text-right">Yard state</th>
              <th className="th text-right">Moves</th>
              <th className="th text-right">Changed</th>
              <th className="th text-right">From scratch</th>
            </tr>
          </thead>
          <tbody>
            {data.versions.map((v) => (
              <tr key={v.id} className="border-t border-slate-100">
                <td className="td font-mono">
                  <Link className="text-accent-700 hover:underline" to="/plans/$id" params={{ id: v.id }}>v{v.versionNo}</Link>
                </td>
                <td className="td"><VersionChip status={v.status} /></td>
                <td className="td">{v.authorName}</td>
                <td className="td max-w-md truncate" title={v.reason}>{v.reason}</td>
                <td className="td num text-right">v{v.basedOnStateVersion}</td>
                <td className="td num text-right">{v.moveCount}</td>
                <td className="td num text-right">{v.stability?.stable.disturbed ?? '–'}</td>
                <td className="td num text-right">{v.stability?.fromScratch.disturbed ?? '–'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h2 className="text-base font-semibold text-slate-900">Overrides this shift</h2>
      <div className="card overflow-x-auto">
        <table className="w-full" aria-label="Overrides">
          <thead>
            <tr>
              <th className="th">When</th>
              <th className="th">Who</th>
              <th className="th">What</th>
              <th className="th">Reason</th>
              <th className="th">Why</th>
              <th className="th">Outcome</th>
            </tr>
          </thead>
          <tbody>
            {overrides.map((o) => (
              <tr key={o.id} className="border-t border-slate-100">
                <td className="td num whitespace-nowrap">{clockDay(o.simAt)}</td>
                <td className="td">{o.actor}</td>
                <td className="td font-mono text-xs">{o.kind}{o.toVersionNo ? ` → v${o.toVersionNo}` : ''}</td>
                <td className="td">{reasonLabel(o.reasonCode)}</td>
                <td className="td max-w-md truncate" title={o.reason}>{o.reason}</td>
                <td className="td">{o.refused ? 'refused' : o.violations?.length ? `overrode ${o.violations.map((v) => v.code).join(', ')}` : 'applied'}</td>
              </tr>
            ))}
            {overrides.length === 0 && (
              <tr><td className="td text-slate-500" colSpan={6}>No overrides yet this shift.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </main>
  )
}
