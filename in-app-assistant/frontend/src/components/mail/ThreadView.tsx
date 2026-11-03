import { useEffect, useState } from 'react'
import { Markdown } from '@/components/assistant/Markdown'
import { AlertIcon, SparkleIcon, SpinnerIcon } from '@/components/icons'
import { ErrorNote, Loading } from '@/components/shared/Loading'
import { api } from '@/services/api'
import { useWorkspaceStore } from '@/stores/workspace-store'
import type { Citation, MailMessage } from '@/types'

/**
 * "Summarize" is a template action, not the agent: one fixed prompt plus this
 * thread, one model call, no tools. Cheaper and more predictable than asking
 * the assistant panel the same thing.
 */
function SummaryBox({ messageId }: { messageId: string }) {
  const [state, setState] = useState<{ text: string; citations: Citation[]; ms: number } | 'loading' | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    setState(null)
    setError(null)
  }, [messageId])
  if (state === null) {
    return (
      <button type="button" className="btn-secondary" onClick={() => {
        setState('loading')
        api.summarizeThread(messageId).then((r) => setState({ text: r.text, citations: r.citations, ms: r.usage.latencyMs })).catch((e) => { setError(e.message); setState(null) })
      }}>
        <SparkleIcon className="h-4 w-4 text-accent-600" /> Summarize thread
      </button>
    )
  }
  return (
    <div className="rounded-lg border border-accent-200 bg-accent-50/60 p-3">
      <div className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-accent-700">
        <SparkleIcon className="h-3.5 w-3.5" /> Summary {state !== 'loading' && <span className="font-normal text-slate-400">· one model call, no tools · {(state.ms / 1000).toFixed(1)}s</span>}
      </div>
      {state === 'loading' ? <div className="flex items-center gap-2 text-sm text-slate-500"><SpinnerIcon /> Summarizing…</div> : <Markdown text={state.text} citations={state.citations} final />}
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  )
}

export function ThreadView({ messageId }: { messageId: string }) {
  const revision = useWorkspaceStore((s) => s.revision)
  const [data, setData] = useState<{ message: MailMessage; thread: MailMessage[] } | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    api.message(messageId).then((d) => live && setData(d)).catch((e) => live && setError(e.message))
    return () => {
      live = false
    }
  }, [messageId, revision])
  if (error) return <ErrorNote message={error} />
  if (!data) return <Loading />
  return (
    <div className="h-full overflow-y-auto px-6 py-5">
      <h2 className="text-xl font-semibold text-slate-900">{data.message.subject}</h2>
      <div className="my-3"><SummaryBox messageId={messageId} /></div>
      <div className="space-y-4">
        {data.thread.map((m) => (
          <article key={m.id} id={m.id} className={`rounded-lg border p-4 ${m.id === messageId ? 'border-accent-200 bg-white' : 'border-slate-200 bg-slate-50/60'}`}>
            {m.external && (
              <div className="mb-2 flex items-center gap-1.5 rounded-md bg-amber-50 px-2 py-1 text-xs text-amber-800">
                <AlertIcon className="h-3.5 w-3.5" /> External sender. Be careful with links and requests in this message.
              </div>
            )}
            <div className="flex items-baseline justify-between gap-2">
              <div className="text-sm"><span className="font-semibold text-slate-900">{m.from.name}</span> <span className="text-slate-400">&lt;{m.from.email}&gt;</span></div>
              <time className="shrink-0 text-xs text-slate-400">{new Date(m.sentAt).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}</time>
            </div>
            <div className="mb-3 text-xs text-slate-400">To {m.to.join(', ')}</div>
            <div className="whitespace-pre-line text-sm leading-relaxed text-slate-700">{m.body}</div>
          </article>
        ))}
      </div>
    </div>
  )
}
