import type { KeyboardEvent } from 'react'
import type { Draft } from '@/stores/drafts-store'

interface Props {
  draft: Draft
  onChange: (patch: Partial<Draft>) => void
  onRun: () => void
}

const TEXTAREA =
  'w-full resize-none rounded-md border border-slate-200 bg-white p-3 font-mono text-[13px] leading-relaxed text-slate-800 focus:border-accent-500 focus:outline-none focus:ring-2 focus:ring-accent-100'

/** System and user message editors. Ctrl/Cmd+Enter runs. */
export function EditorPanel({ draft, onChange, onRun }: Props) {
  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      onRun()
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex flex-col">
        <label className="panel-title mb-1.5" htmlFor="system-prompt">
          System
        </label>
        <textarea
          id="system-prompt"
          className={`${TEXTAREA} h-32`}
          placeholder="Instructions that frame every request, e.g. You are a support triage assistant for {{product}}."
          value={draft.system}
          onChange={(e) => onChange({ system: e.target.value })}
          onKeyDown={onKeyDown}
        />
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        <label className="panel-title mb-1.5" htmlFor="user-template">
          User message
        </label>
        <textarea
          id="user-template"
          className={`${TEXTAREA} min-h-[9rem] flex-1`}
          placeholder="The request. Use {{variable}} placeholders for inputs that change between runs."
          value={draft.template}
          onChange={(e) => onChange({ template: e.target.value })}
          onKeyDown={onKeyDown}
        />
      </div>
    </div>
  )
}
