import { createFileRoute } from '@tanstack/react-router'
import { InboxIcon } from '@/components/icons'
import { PathControls } from '@/components/receiver/PathControls'
import { ReceivedTable } from '@/components/receiver/ReceivedTable'
import { ErrorNote, Loading } from '@/components/shared/Loading'
import { StatTile } from '@/components/shared/StatTile'
import { usePoll } from '@/lib/use-poll'
import { api } from '@/services/api'

export const Route = createFileRoute('/receiver')({ component: ReceiverPage })

function ReceiverPage() {
  const { data, error, reload } = usePoll(() => api.receiver(), 1500)
  return (
    <div className="page">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="h1">Mock receiver</h1>
          <p className="mt-1 text-sm text-slate-500">
            Stands in for your servers{data ? <> at <span className="code">{data.receiverUrl}</span></> : null}. It verifies signatures, dedupes by event id and can misbehave on demand.
            You only see the paths your own endpoints use.
          </p>
        </div>
        <button type="button" className="btn-secondary" onClick={() => void api.clearReceiver().then(reload)}>Clear log</button>
      </div>
      {error && <ErrorNote message={error} />}
      {!data ? (
        <Loading />
      ) : (
        <>
          {data.stats && (
            <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
              <StatTile label="Requests" value={data.stats.requests} icon={<InboxIcon />} />
              <StatTile label="Unique events applied" value={data.stats.uniqueEvents} />
              <StatTile label="Duplicates caught" value={data.stats.duplicates} hint="same event id seen again" />
              <StatTile label="Bad signatures" value={data.stats.badSignatures} />
              <StatTile label="Stale (out of order)" value={data.stats.stale} />
            </div>
          )}
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {data.paths.map((p) => <PathControls key={p.name} path={p} onChange={reload} />)}
          </div>
          <section className="card">
            <h2 className="border-b border-slate-200 px-4 py-3 text-sm font-semibold text-slate-900">Received</h2>
            <ReceivedTable entries={data.received} />
          </section>
        </>
      )}
    </div>
  )
}
