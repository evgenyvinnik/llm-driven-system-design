import { useState } from 'react'
import { CheckIcon, SparkleIcon, UndoIcon } from '@/components/icons'
import type { Paragraph } from '@/types'

const KIND_CLASS: Record<Paragraph['kind'], string> = {
  title: 'text-2xl font-bold text-slate-900',
  heading: 'mt-4 text-lg font-semibold text-slate-900',
  body: 'text-[15px] leading-relaxed text-slate-700',
  bullet: "pl-5 text-[15px] leading-relaxed text-slate-700 before:-ml-4 before:mr-2 before:content-['•']",
}

interface Props {
  paragraph: Paragraph
  selected: boolean
  highlighted: boolean
  editable: boolean
  onSelect: (extend: boolean) => void
  onSave: (text: string) => Promise<void>
  onDecide: (decision: 'accept' | 'reject') => void
}

/**
 * One paragraph with its stable ID. Assistant edits arrive as tracked
 * suggestions: Keep applies them, Undo removes them, and both are recorded
 * as a live signal of whether AI edits are wanted.
 */
export function ParagraphBlock({ paragraph: p, selected, highlighted, editable, onSelect, onSave, onDecide }: Props) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(p.text)
  const suggested = p.suggestion !== null
  return (
    <div
      id={p.id}
      data-paragraph={p.id}
      onClick={(e) => !editing && onSelect(e.shiftKey)}
      onDoubleClick={() => editable && !suggested && (setDraft(p.text), setEditing(true))}
      className={`group relative -mx-3 cursor-text rounded-md px-3 py-1 ${selected ? 'bg-sky-50 ring-1 ring-sky-200' : 'hover:bg-slate-50'} ${highlighted ? 'animate-flash' : ''}`}
    >
      <span className="absolute -left-12 top-1.5 hidden w-10 text-right font-mono text-[10px] text-slate-300 group-hover:block">{p.id}</span>
      {editing ? (
        <div className="space-y-2" onClick={(e) => e.stopPropagation()}>
          <textarea className="input min-h-[80px] text-[15px]" value={draft} onChange={(e) => setDraft(e.target.value)} autoFocus />
          <div className="flex gap-2">
            <button type="button" className="btn-primary" onClick={() => void onSave(draft).then(() => setEditing(false))}>Save</button>
            <button type="button" className="btn-secondary" onClick={() => setEditing(false)}>Cancel</button>
          </div>
        </div>
      ) : p.suggestion === 'replace' ? (
        <div className={KIND_CLASS[p.kind]}>
          <span className="bg-red-50 text-red-700 line-through decoration-red-300">{p.text}</span>{' '}
          <span className="bg-emerald-50 text-emerald-800 underline decoration-emerald-300">{p.suggestedText}</span>
        </div>
      ) : (
        <div className={`${KIND_CLASS[p.kind]} ${p.suggestion === 'insert' ? 'rounded bg-emerald-50 text-emerald-900 underline decoration-emerald-300 decoration-1 underline-offset-4' : ''}`}>{p.text}</div>
      )}
      {suggested && !editing && (
        <div className="mt-1 flex items-center gap-2 text-xs" onClick={(e) => e.stopPropagation()}>
          <span className="flex items-center gap-1 text-emerald-700"><SparkleIcon className="h-3 w-3" /> Suggested by the assistant</span>
          {editable && (
            <>
              <button type="button" className="btn-secondary px-2 py-0.5 text-xs" onClick={() => onDecide('accept')}><CheckIcon className="h-3 w-3" /> Keep</button>
              <button type="button" className="btn-secondary px-2 py-0.5 text-xs" onClick={() => onDecide('reject')}><UndoIcon className="h-3 w-3" /> Undo</button>
            </>
          )}
        </div>
      )}
    </div>
  )
}
