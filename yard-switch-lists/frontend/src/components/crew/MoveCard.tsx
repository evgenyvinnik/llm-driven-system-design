import { useState } from 'react'
import { MoveStatusChip } from '@/components/shared/Chips'
import { clock, describeMove, KIND_LABEL } from '@/lib/format'
import type { CrewMove } from '@/types'

export type ProblemKind = 'car_not_found' | 'track_blocked' | 'different_cars'

interface Props {
  move: CrewMove
  trainName: (id: string) => string
  status: CrewMove['status']
  busy: boolean
  onStart: () => void
  onComplete: () => void
  onProblem: (kind: ProblemKind, carIds: string[], note: string) => void
}

const PROBLEMS: { kind: ProblemKind; label: string }[] = [
  { kind: 'car_not_found', label: "A car isn't where it should be" },
  { kind: 'track_blocked', label: 'The track is blocked' },
  { kind: 'different_cars', label: 'I moved different cars' },
]

export function MoveCard({ move, trainName, status, busy, onStart, onComplete, onProblem }: Props) {
  const [open, setOpen] = useState(false)
  const [kind, setKind] = useState<ProblemKind>('car_not_found')
  const [picked, setPicked] = useState<string[]>([])
  const [note, setNote] = useState('')
  const toggle = (id: string) => setPicked((list) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]))
  const inProgress = status === 'in_progress'
  return (
    <li className="card p-3" data-testid="crew-move" data-move-key={move.key}>
      <div className="flex items-center gap-2 text-xs text-slate-500">
        <span className="font-semibold uppercase tracking-wide">{KIND_LABEL[move.kind]}</span>
        <span className="num">{clock(move.plannedStart)}Z</span>
        <span className="ml-auto"><MoveStatusChip status={status} /></span>
      </div>
      <p className="mt-1 text-base font-semibold text-slate-900">{describeMove(move, trainName)}</p>
      <p className="mt-0.5 truncate text-xs text-slate-500" title={move.carIds.join(', ')}>{move.carIds.join(', ')}</p>
      {move.blockedByHold && (
        <p className="mt-2 rounded-md bg-rose-100 px-2 py-1 text-sm font-medium text-rose-900" role="alert">
          Stop: {move.heldCars.join(', ')} on hold. Don&apos;t move this cut.
        </p>
      )}
      <div className="mt-3 grid grid-cols-2 gap-2">
        {inProgress ? (
          <button type="button" className="btn-primary col-span-2 h-12 text-base" disabled={busy} onClick={onComplete} data-testid="crew-complete">Complete</button>
        ) : (
          <button type="button" className="btn-primary col-span-2 h-12 text-base" disabled={busy || !move.ready} onClick={onStart} data-testid="crew-start">{move.ready ? 'Start' : 'Not ready yet'}</button>
        )}
        <button type="button" className="btn-secondary col-span-2 h-10" onClick={() => setOpen((x) => !x)} data-testid="crew-problem">Report a problem</button>
      </div>
      {open && (
        <div className="mt-3 space-y-2 border-t border-slate-100 pt-2">
          {PROBLEMS.map((p) => (
            <label key={p.kind} className="flex items-center gap-2 text-sm">
              <input type="radio" name={`problem-${move.key}`} checked={kind === p.kind} onChange={() => setKind(p.kind)} /> {p.label}
            </label>
          ))}
          {kind !== 'track_blocked' && (
            <div className="flex flex-wrap gap-1">
              {move.carIds.map((id) => (
                <button key={id} type="button" onClick={() => toggle(id)} className={`chip border ${picked.includes(id) ? 'border-accent-600 bg-accent-100 text-accent-700' : 'border-slate-200 text-slate-600'}`}>
                  {id}
                </button>
              ))}
              <p className="w-full text-xs text-slate-500">{kind === 'car_not_found' ? 'Tap the cars you can’t find.' : 'Tap the cars you actually moved.'}</p>
            </div>
          )}
          <input className="input" placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
          <button
            type="button"
            className="btn-danger h-10 w-full"
            disabled={busy || (kind !== 'track_blocked' && picked.length === 0)}
            onClick={() => {
              onProblem(kind, picked, note)
              setOpen(false)
            }}
            data-testid="crew-send-problem"
          >
            Send report
          </button>
        </div>
      )}
    </li>
  )
}
