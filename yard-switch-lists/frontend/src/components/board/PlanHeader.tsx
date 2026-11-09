import { Link } from '@tanstack/react-router'
import { RefreshIcon } from '@/components/icons'
import { Chip, VersionChip } from '@/components/shared/Chips'
import { clockDay } from '@/lib/format'
import type { Board } from '@/types'

export function PlanHeader({ board, busy, onPublish, onDiscard, onReplan }: { board: Board; busy: boolean; onPublish: () => void; onDiscard: () => void; onReplan: () => void }) {
  const w = board.working
  const canPublish = w && w.status === 'draft' && w.conflicts.length === 0 && board.validation.ok
  return (
    <header className="flex flex-wrap items-center gap-3">
      <h1 className="text-lg font-semibold text-slate-900">Sandhills yard board</h1>
      <span className="num text-sm text-slate-600" title="Simulated yard clock">{clockDay(board.now)}Z · shift {board.shiftId}</span>
      <Chip kind="muted">yard state v{board.stateVersion}</Chip>
      {w && (
        <span className="flex items-center gap-1.5 text-sm" data-testid="plan-version">
          Plan v{w.versionNo} <VersionChip status={w.status} />
          <span className="text-xs text-slate-500">by {w.authorName}: {w.reason.length > 46 ? `${w.reason.slice(0, 46)}…` : w.reason}</span>
        </span>
      )}
      <div className="flex-1" />
      {w && w.parentId && (
        <Link className="btn-secondary" to="/plans/$id" params={{ id: w.id }}>Diff</Link>
      )}
      <button type="button" className="btn-secondary" onClick={onReplan} disabled={busy}>
        <RefreshIcon /> Replan
      </button>
      {w?.status === 'draft' && (
        <>
          <button type="button" className="btn-ghost" onClick={onDiscard} disabled={busy}>Discard</button>
          <button type="button" className="btn-primary" onClick={onPublish} disabled={busy || !canPublish} data-testid="publish">
            Publish v{w.versionNo}
          </button>
        </>
      )}
    </header>
  )
}
