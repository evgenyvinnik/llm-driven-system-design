import { createFileRoute } from '@tanstack/react-router'
import { useCallback, useMemo, useState } from 'react'
import { Banners } from '@/components/board/Banners'
import { EditDialog, type PendingEdit } from '@/components/board/EditDialog'
import { LockList } from '@/components/board/LockList'
import { MoveList } from '@/components/board/MoveList'
import { PlanHeader } from '@/components/board/PlanHeader'
import { InboundPanel, ReadinessPanel } from '@/components/board/Readiness'
import { TrackLanes } from '@/components/board/TrackLanes'
import { ErrorNote, Loading } from '@/components/shared/Loading'
import { ReasonDialog, type ReasonValue } from '@/components/shared/ReasonDialog'
import { clock } from '@/lib/format'
import { usePolling } from '@/lib/usePolling'
import { ApiError, api, type EditOp } from '@/services/api'
import type { Move, Readiness, TrackView, Violation } from '@/types'

export const Route = createFileRoute('/board')({ component: BoardPage })

type Notice = { tone: 'bad' | 'warn' | 'info'; text: string; action?: { label: string; run: () => void } } | null
type Ask = { title: string; confirm: string; run: (v: ReasonValue) => Promise<void> } | null

function BoardPage() {
  const { data: board, error, refresh } = usePolling(api.board, 2000)
  const [dropTrack, setDropTrack] = useState<string | null>(null)
  const [edit, setEdit] = useState<PendingEdit | null>(null)
  const [editViolations, setEditViolations] = useState<Violation[] | null>(null)
  const [overridable, setOverridable] = useState(false)
  const [notice, setNotice] = useState<Notice>(null)
  const [ask, setAsk] = useState<Ask>(null)
  const [busy, setBusy] = useState(false)

  const trainName = useCallback((id: string) => board?.readiness.find((r) => r.outboundId === id)?.symbol ?? id, [board?.readiness])
  const moves = useMemo(() => board?.moves ?? [], [board?.moves])

  const startEdit = (title: string, ops: EditOp[]) => {
    if (!board?.working) return
    const { id, versionNo } = board.working
    setEditViolations(null)
    setOverridable(false)
    const pending: PendingEdit = {
      title,
      apply: async (v, overrideSoft) => {
        await api.edit(id, { expectedVersionNo: versionNo, ops, reason: v.reason, reasonCode: v.reasonCode, overrideSoft })
      },
    }
    setEdit(pending)
  }

  const submitEdit = async (v: ReasonValue, overrideSoft: boolean) => {
    if (!edit) return
    setBusy(true)
    try {
      await edit.apply(v, overrideSoft)
      setEdit(null)
      setNotice({ tone: 'info', text: 'Edit saved as a new draft. Publish it when you are ready for crews to see it.' })
      await refresh()
    } catch (err) {
      if (err instanceof ApiError && (err.code === 'NEEDS_OVERRIDE' || err.code === 'EDIT_REFUSED')) {
        setEditViolations(err.details?.violations ?? [])
        setOverridable(err.code === 'NEEDS_OVERRIDE')
      } else if (err instanceof ApiError && err.code === 'VERSION_CONFLICT') {
        setEdit(null)
        setNotice({ tone: 'bad', text: `${err.details?.currentAuthor ?? 'Someone'} changed the plan first (now v${err.details?.current}). Your edit wasn't applied. Nothing was overwritten.`, action: { label: 'Load the latest', run: () => void refresh().then(() => setNotice(null)) } })
        await refresh()
      } else {
        setEdit(null)
        setNotice({ tone: 'bad', text: err instanceof Error ? err.message : 'The edit failed' })
      }
    } finally {
      setBusy(false)
    }
  }

  const run = async (fn: () => Promise<unknown>, done?: string) => {
    setBusy(true)
    try {
      await fn()
      if (done) setNotice({ tone: 'info', text: done })
    } catch (err) {
      const text = err instanceof Error ? err.message : 'That failed'
      setNotice({ tone: err instanceof ApiError && err.code === 'STALE_STATE' ? 'warn' : 'bad', text })
    } finally {
      setBusy(false)
      await refresh()
    }
  }

  if (error && !board) return <main className="page"><ErrorNote message={error} /></main>
  if (!board) return <Loading label="Loading the yard…" />

  const lockMove = (m: Move) =>
    setAsk({ title: `Lock ${m.key}`, confirm: 'Lock', run: (v) => run(() => api.lockMove(m.key, v.reason, v.reasonCode), `Locked ${m.key}. The planner will keep it.`) })
  const release = (lockId: string, label: string) =>
    setAsk({ title: `Release: ${label}`, confirm: 'Release', run: (v) => run(() => api.releaseLock(lockId, v.reason, v.reasonCode), 'Lock released. A replan is queued.') })
  const unlockMove = (m: Move) => m.lockId && release(m.lockId, m.key)
  const holdTrain = (r: Readiness) => {
    const later = new Date(new Date(r.departure).getTime() + 30 * 60_000).toISOString()
    setAsk({ title: `Hold ${r.symbol} 30 min, to ${clock(later)}Z. This overrides its departure time, and on-time metrics still count from ${clock(r.scheduledDeparture)}Z.`, confirm: 'Hold and record', run: (v) => run(() => api.reviseDeparture(r.outboundId, later, v.reason, v.reasonCode), `${r.symbol} held to ${clock(later)}Z.`) })
  }
  const toggleTrack = (t: TrackView) =>
    setAsk({ title: t.open ? `Block ${t.name}?` : `Reopen ${t.name}?`, confirm: t.open ? 'Block track' : 'Reopen', run: (v) => run(() => api.simScenario(t.open ? 'block-track' : 'unblock-track', { trackId: t.id, reason: v.reason })) })

  return (
    <main className="page" data-testid="board">
      <PlanHeader
        board={board}
        busy={busy}
        onPublish={() => board.working && void run(() => api.publish(board.working!.id), `Published v${board.working.versionNo}.`)}
        onDiscard={() => board.working && void run(() => api.discard(board.working!.id), 'Draft discarded.')}
        onReplan={() => void run(() => api.replan('requested from the board'), 'Replan queued.')}
      />
      <Banners board={board} onRelease={(c) => release(c.lockId, c.message)} onAck={(id) => void run(() => api.ackAlert(id))} notice={notice} onDismissNotice={() => setNotice(null)} />
      <div className="grid gap-4 xl:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <div className="space-y-4">
          <TrackLanes tracks={board.tracks} dropTrackId={dropTrack} onBlockToggle={toggleTrack} />
          <ReadinessPanel readiness={board.readiness} onHold={holdTrain} />
        </div>
        <div className="space-y-4">
          <MoveList
            moves={moves}
            editable={Boolean(board.working)}
            trainName={trainName}
            onHoverTrack={setDropTrack}
            onReorder={(m, to) => startEdit(`Move ${m.key} to position ${to + 1}`, [{ op: 'reorder', moveKey: m.key, toIndex: to }])}
            onRetarget={(m, track) => startEdit(`Send ${m.key} to ${track}`, [{ op: 'retarget', moveKey: m.key, toTrackId: track }])}
            onLock={lockMove}
            onUnlock={unlockMove}
          />
          <div className="grid gap-4 md:grid-cols-2">
            <LockList locks={board.locks} onRelease={(l) => release(l.id, l.moveKey ?? l.carId ?? 'lock')} />
            <InboundPanel inbound={board.inbound} />
          </div>
        </div>
      </div>
      {edit && <EditDialog edit={edit} violations={editViolations} overridable={overridable} busy={busy} onCancel={() => setEdit(null)} onConfirm={(v, soft) => void submitEdit(v, soft)} />}
      {ask && (
        <ReasonDialog
          title={ask.title}
          confirmLabel={ask.confirm}
          busy={busy}
          onCancel={() => setAsk(null)}
          onConfirm={(v) => {
            const current = ask
            setAsk(null)
            void current.run(v)
          }}
        />
      )}
    </main>
  )
}
