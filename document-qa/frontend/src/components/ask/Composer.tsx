import { useState, type FormEvent, type KeyboardEvent } from 'react'
import { SendIcon } from '@/components/icons'
import { useAskStore } from '@/stores/ask-store'

const EXAMPLES = ['How long do I have to submit expense receipts?', 'How many vacation days do employees get?', 'What is the backup retention period?']

export function Composer() {
  const ask = useAskStore((s) => s.ask)
  const [question, setQuestion] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e?: FormEvent) {
    e?.preventDefault()
    const q = question.trim()
    if (q.length < 3 || busy) return
    setBusy(true)
    setError(null)
    try {
      await ask(q)
      setQuestion('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not ask')
    } finally {
      setBusy(false)
    }
  }

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void submit()
    }
  }

  return (
    <form aria-label="Ask" onSubmit={(e) => void submit(e)} className="card space-y-2 p-3">
      <textarea
        name="question"
        className="input min-h-[64px] resize-y"
        placeholder="Ask a question about your documents…"
        value={question}
        onChange={(e) => setQuestion(e.target.value)}
        onKeyDown={onKey}
      />
      <div className="flex flex-wrap items-center gap-2">
        {EXAMPLES.map((q) => (
          <button key={q} type="button" className="rounded-full border border-slate-200 px-2.5 py-0.5 text-xs text-slate-600 hover:bg-slate-50" onClick={() => setQuestion(q)}>
            {q}
          </button>
        ))}
        <span className="flex-1" />
        {error && <span className="text-xs text-rose-800">{error}</span>}
        <button type="submit" className="btn-primary" disabled={busy || question.trim().length < 3}>
          <SendIcon className="h-3.5 w-3.5" /> Ask
        </button>
      </div>
    </form>
  )
}
