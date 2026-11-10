import { useEffect, useRef, useState } from 'react'
import { clampToEditable, insertionIndex } from '@/lib/drag'
import type { Move } from '@/types'
import { MoveRow } from './MoveRow'

interface Props {
  moves: Move[]
  editable: boolean
  trainName: (id: string) => string
  onReorder: (move: Move, toIndex: number) => void
  onRetarget: (move: Move, trackId: string) => void
  onLock: (move: Move) => void
  onUnlock: (move: Move) => void
  onHoverTrack: (trackId: string | null) => void
}

/**
 * Drag with pointer events rather than HTML5 drag-and-drop: one code path for
 * mouse, touch and pen. Alt+Up/Down and L on a focused row do the same work from
 * the keyboard.
 */
export function MoveList({ moves, editable, trainName, onReorder, onRetarget, onLock, onUnlock, onHoverTrack }: Props) {
  const listRef = useRef<HTMLOListElement>(null)
  const [drag, setDrag] = useState<{ from: number; to: number } | null>(null)
  const [hideDone, setHideDone] = useState(false)
  const firstEditable = Math.max(0, moves.findIndex((m) => m.status === 'pending' && m.crew !== 'road'))
  const dragRef = useRef(drag)
  dragRef.current = drag

  useEffect(() => {
    if (!drag) return
    const trackAt = (x: number, y: number) => (document.elementFromPoint(x, y)?.closest('[data-track-id]') as HTMLElement | null)?.dataset.trackId ?? null
    const onMove = (e: PointerEvent) => {
      onHoverTrack(trackAt(e.clientX, e.clientY))
      const rows = [...(listRef.current?.querySelectorAll('[data-move-key]') ?? [])].map((el) => {
        const r = el.getBoundingClientRect()
        return { top: r.top, bottom: r.bottom }
      })
      const current = dragRef.current
      if (!current) return
      const visibleFrom = moves[current.from] ? visibleIndex(moves, hideDone, current.from) : 0
      const toVisible = insertionIndex(e.clientY, rows, visibleFrom)
      const to = clampToEditable(actualIndex(moves, hideDone, toVisible), firstEditable, moves.length)
      if (to !== current.to) setDrag({ ...current, to })
    }
    const onUp = (e: PointerEvent) => {
      const current = dragRef.current
      const track = trackAt(e.clientX, e.clientY)
      onHoverTrack(null)
      setDrag(null)
      if (!current) return
      const move = moves[current.from]
      if (track) onRetarget(move, track)
      else if (current.to !== current.from) onReorder(move, current.to)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onHoverTrack(null)
        setDrag(null)
      }
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('keydown', onKey)
    }
  }, [drag !== null, moves, firstEditable, hideDone]) // eslint-disable-line react-hooks/exhaustive-deps

  const shown = moves.map((m, i) => ({ m, i })).filter(({ m }) => !hideDone || m.status !== 'done')
  const nudge = (index: number, by: number) => {
    const to = clampToEditable(index + by, firstEditable, moves.length)
    if (to !== index) onReorder(moves[index], to)
  }
  return (
    <section aria-label="Switch list" className="card">
      <div className="flex items-center justify-between border-b border-slate-200 px-3 py-2">
        <h2 className="panel-title">Switch list · {moves.length} moves</h2>
        <label className="flex items-center gap-1.5 text-xs text-slate-600">
          <input type="checkbox" checked={hideDone} onChange={(e) => setHideDone(e.target.checked)} /> Hide done
        </label>
      </div>
      <ol ref={listRef} className="max-h-[720px] overflow-y-auto" aria-label="Ordered moves">
        {shown.map(({ m, i }) => (
          <MoveRow
            key={m.key}
            move={m}
            index={i}
            editable={editable}
            trainName={trainName}
            dragging={drag?.from === i}
            indicator={drag !== null && drag.to === i && drag.from !== i}
            onGrip={(e, index) => {
              e.preventDefault()
              setDrag({ from: index, to: index })
            }}
            onNudge={nudge}
            onLock={onLock}
            onUnlock={onUnlock}
          />
        ))}
      </ol>
      <p className="border-t border-slate-100 px-3 py-1.5 text-xs text-slate-500">Keyboard: focus a row, Alt+↑/↓ reorders, L locks or unlocks.</p>
    </section>
  )
}

function visibleIndex(moves: Move[], hideDone: boolean, actual: number): number {
  if (!hideDone) return actual
  return moves.slice(0, actual).filter((m) => m.status !== 'done').length
}

function actualIndex(moves: Move[], hideDone: boolean, visible: number): number {
  if (!hideDone) return visible
  let seen = -1
  for (let i = 0; i < moves.length; i++) {
    if (moves[i].status !== 'done') seen++
    if (seen === visible) return i
  }
  return moves.length - 1
}
