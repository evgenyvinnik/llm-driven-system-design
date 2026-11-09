import { ArrowDownIcon, ArrowUpIcon, GripIcon, LockIcon, UnlockIcon } from '@/components/icons'
import { MoveStatusChip } from '@/components/shared/Chips'
import { clock, describeMove, KIND_LABEL } from '@/lib/format'
import type { Move } from '@/types'

interface Props {
  move: Move
  index: number
  editable: boolean
  trainName: (id: string) => string
  dragging: boolean
  indicator: boolean
  onGrip: (e: React.PointerEvent, index: number) => void
  onNudge: (index: number, by: number) => void
  onLock: (move: Move) => void
  onUnlock: (move: Move) => void
}

export function MoveRow({ move, index, editable, trainName, dragging, indicator, onGrip, onNudge, onLock, onUnlock }: Props) {
  const started = move.status !== 'pending'
  const canEdit = editable && !started && move.crew !== 'road'
  return (
    <li
      data-move-key={move.key}
      data-testid="move-row"
      tabIndex={canEdit ? 0 : -1}
      aria-label={`${index + 1}. ${describeMove(move, trainName)}. ${move.status}`}
      onKeyDown={(e) => {
        if (!canEdit) return
        if (e.altKey && e.key === 'ArrowUp') {
          e.preventDefault()
          onNudge(index, -1)
        } else if (e.altKey && e.key === 'ArrowDown') {
          e.preventDefault()
          onNudge(index, 1)
        } else if (e.key.toLowerCase() === 'l' && !e.metaKey && !e.ctrlKey) {
          e.preventDefault()
          if (move.lockId) onUnlock(move)
          else onLock(move)
        }
      }}
      className={`flex items-center gap-2 border-b border-slate-100 px-2 py-1 text-sm outline-none last:border-b-0 focus:bg-accent-50 ${started ? 'bg-slate-50 text-slate-500' : ''} ${dragging ? 'opacity-40' : ''} ${indicator ? 'shadow-[inset_0_2px_0_0_#2563eb]' : ''}`}
    >
      <button
        type="button"
        data-testid="move-grip"
        disabled={!canEdit}
        onPointerDown={(e) => canEdit && onGrip(e, index)}
        className="touch-none cursor-grab text-slate-400 disabled:cursor-default disabled:opacity-30"
        aria-label={`Drag ${move.key}`}
        tabIndex={-1}
      >
        <GripIcon />
      </button>
      <span className="num w-7 text-right text-xs text-slate-400">{index + 1}</span>
      <span className="num w-11 text-xs text-slate-600">{clock(move.plannedStart)}</span>
      <span className="w-[60px] text-xs font-medium text-slate-500">{KIND_LABEL[move.kind]}</span>
      <span className="min-w-0 flex-1 truncate" title={move.key}>
        {describeMove(move, trainName)}
      </span>
      {move.heldCars.length > 0 && (move.status === 'pending' || move.status === 'in_progress') && <span className="chip bg-rose-100 text-rose-900">hold {move.heldCars.length}</span>}
      <MoveStatusChip status={move.status} />
      {canEdit && (
        <span className="hidden items-center gap-0.5 xl:flex">
          <button type="button" className="rounded p-0.5 text-slate-400 hover:bg-slate-100" onClick={() => onNudge(index, -1)} aria-label={`Move ${move.key} up`}>
            <ArrowUpIcon className="h-3.5 w-3.5" />
          </button>
          <button type="button" className="rounded p-0.5 text-slate-400 hover:bg-slate-100" onClick={() => onNudge(index, 1)} aria-label={`Move ${move.key} down`}>
            <ArrowDownIcon className="h-3.5 w-3.5" />
          </button>
        </span>
      )}
      {move.lockId ? (
        <button type="button" className="rounded p-0.5 text-accent-700 hover:bg-slate-100" onClick={() => onUnlock(move)} title="Locked. Click to release." aria-label={`Release lock on ${move.key}`}>
          <LockIcon />
        </button>
      ) : (
        <button type="button" disabled={!canEdit} className="rounded p-0.5 text-slate-300 hover:bg-slate-100 hover:text-slate-600 disabled:opacity-30" onClick={() => onLock(move)} title="Lock this move" aria-label={`Lock ${move.key}`}>
          <UnlockIcon />
        </button>
      )}
    </li>
  )
}
