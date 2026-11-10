import { createFileRoute } from '@tanstack/react-router'
import { useCallback, useState } from 'react'
import { MoveCard, type ProblemKind } from '@/components/crew/MoveCard'
import { RefreshIcon, WifiOffIcon } from '@/components/icons'
import { ErrorNote, Loading } from '@/components/shared/Loading'
import { clock } from '@/lib/format'
import { newReportId, outbox } from '@/lib/outbox'
import { usePolling } from '@/lib/usePolling'
import { ApiError, api } from '@/services/api'
import type { CrewMove, CrewReportInput } from '@/types'

export const Route = createFileRoute('/crew')({ component: CrewPage })

const NEXT_SHOWN = 6

function CrewPage() {
  const [crew, setCrew] = useState<'all' | 'hump' | 'trim'>('all')
  const [offline, setOffline] = useState(false)
  const [queued, setQueued] = useState(() => outbox.list().length)
  const [message, setMessage] = useState<{ tone: 'bad' | 'info'; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const fetcher = useCallback(() => api.crewMoves(crew), [crew])
  const { data, error, refresh } = usePolling(fetcher, offline ? 0 : 3000)

  const send = async (report: Omit<CrewReportInput, 'clientReportId' | 'occurredAt' | 'offline'>) => {
    const full: CrewReportInput = { ...report, clientReportId: newReportId(), occurredAt: data?.now }
    if (offline) {
      outbox.add({ ...full, offline: true })
      setQueued(outbox.list().length)
      setMessage({ tone: 'info', text: 'Saved on this handheld. It will sync when you are back online.' })
      return
    }
    setBusy(true)
    try {
      const { result } = await api.crewReport(full)
      setMessage(result.mismatch ? { tone: 'info', text: 'Reported. The board has been updated and a replan is on its way.' } : null)
    } catch (err) {
      setMessage({ tone: 'bad', text: err instanceof ApiError ? ((err.body as { result?: { message?: string } })?.result?.message ?? err.message) : 'Could not send the report' })
    } finally {
      setBusy(false)
      await refresh()
    }
  }

  const sync = async () => {
    const list = outbox.list()
    if (list.length === 0) return
    setBusy(true)
    try {
      const { results } = await api.crewBatch(list)
      outbox.remove(results.filter((r) => r.outcome !== 'rejected').map((r) => r.clientReportId))
      setQueued(outbox.list().length)
      setMessage({ tone: 'info', text: `Synced ${results.length} report${results.length === 1 ? '' : 's'}.` })
    } catch {
      setMessage({ tone: 'bad', text: 'Still no connection. Your reports are safe on this handheld.' })
    } finally {
      setBusy(false)
      await refresh()
    }
  }

  if (error && !data) return <main className="mx-auto max-w-md p-3"><ErrorNote message={error} /></main>
  if (!data) return <Loading label="Loading your moves…" />

  const statusOf = (m: CrewMove) => outbox.localStatus(m.key) ?? m.status
  const moves = data.moves.filter((m) => statusOf(m) !== 'done').slice(0, NEXT_SHOWN)
  return (
    <main className="mx-auto max-w-md space-y-3 p-3" data-testid="crew-view">
      <header className="flex items-center gap-2">
        <h1 className="text-lg font-semibold text-slate-900">Next moves</h1>
        <span className="text-xs text-slate-500">Plan v{data.versionNo ?? '–'} · {clock(data.now)}Z</span>
        <button type="button" className={`ml-auto btn-secondary ${offline ? '!border-amber-400 !bg-amber-50' : ''}`} aria-pressed={offline} onClick={() => setOffline((x) => !x)} data-testid="crew-offline">
          <WifiOffIcon /> {offline ? 'Offline' : 'Go offline'}
        </button>
      </header>
      <div className="flex gap-1" role="group" aria-label="Crew">
        {(['all', 'hump', 'trim'] as const).map((c) => (
          <button key={c} type="button" onClick={() => setCrew(c)} aria-pressed={crew === c} className={`btn flex-1 ${crew === c ? 'bg-slate-800 text-white' : 'bg-slate-100 text-slate-700'}`}>
            {c === 'all' ? 'All' : c === 'hump' ? 'Hump crew' : 'Trim crew'}
          </button>
        ))}
      </div>
      {data.replanPending && <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">A new plan is waiting for the yardmaster. Keep working from this one.</p>}
      {queued > 0 && (
        <div className="flex items-center gap-2 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900" data-testid="crew-queue">
          <span className="flex-1">{queued} report{queued === 1 ? '' : 's'} waiting to sync</span>
          <button type="button" className="btn-secondary" disabled={offline || busy} onClick={() => void sync()} data-testid="crew-sync">
            <RefreshIcon /> Sync
          </button>
        </div>
      )}
      {message && (
        <p className={`rounded-md px-3 py-2 text-sm ${message.tone === 'bad' ? 'bg-rose-100 text-rose-900' : 'bg-sky-50 text-sky-900'}`} role="alert" data-testid="crew-message">
          {message.text}
        </p>
      )}
      <ul className="space-y-2">
        {moves.map((m) => (
          <MoveCard
            key={m.key}
            move={m}
            trainName={(id) => data.trains[id] ?? id}
            status={statusOf(m) as CrewMove['status']}
            busy={busy}
            onStart={() => void send({ moveKey: m.key, kind: 'start' }).then(() => setQueued(outbox.list().length))}
            onComplete={() => void send({ moveKey: m.key, kind: 'complete' }).then(() => setQueued(outbox.list().length))}
            onProblem={(kind: ProblemKind, carIds, note) => void send({ moveKey: m.key, kind: 'exception', exceptionType: kind, carIds: carIds.length ? carIds : undefined, trackId: kind === 'track_blocked' ? m.toTrackId : undefined, note: note || undefined })}
          />
        ))}
        {moves.length === 0 && <li className="card p-4 text-sm text-slate-500">Nothing on the list for this crew right now.</li>}
      </ul>
    </main>
  )
}
