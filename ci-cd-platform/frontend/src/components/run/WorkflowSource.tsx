import { useState } from 'react'
import { api } from '@/services/api'

export function WorkflowSource({ runId }: { runId: string }) {
  const [content, setContent] = useState<string | null>(null)
  const [open, setOpen] = useState(false)

  function toggle() {
    if (!open && content === null) void api.workflow(runId).then((w) => setContent(w.content))
    setOpen(!open)
  }

  return (
    <div className="p-3">
      <button type="button" className="btn-ghost" onClick={toggle} aria-expanded={open}>
        {open ? 'Hide' : 'Show'} the pinned workflow file
      </button>
      {open && <pre className="mt-2 max-h-96 overflow-auto rounded-md bg-slate-900 p-3 font-mono text-xs leading-5 text-slate-100">{content ?? 'Loading…'}</pre>}
    </div>
  )
}
