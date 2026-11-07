import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useRef } from 'react'
import { AnswerCard } from '@/components/ask/AnswerCard'
import { Composer } from '@/components/ask/Composer'
import { Empty, ErrorNote, Loading } from '@/components/shared/Loading'
import { useAskStore } from '@/stores/ask-store'

export const Route = createFileRoute('/ask')({ component: Ask })

function Ask() {
  const runs = useAskStore((s) => s.runs)
  const loaded = useAskStore((s) => s.loaded)
  const error = useAskStore((s) => s.error)
  const end = useRef<HTMLDivElement>(null)
  const last = runs.at(-1)

  useEffect(() => {
    void useAskStore.getState().load()
    // History is re-validated by the server on every read; refetch so a revoke or delete reaches an open page.
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible') void useAskStore.getState().refresh()
    }, 15_000)
    return () => window.clearInterval(id)
  }, [])
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' })
  }, [runs.length, last?.outputText.length])

  return (
    <div className="page !max-w-4xl">
      <div>
        <h1 className="h1">Ask your documents</h1>
        <p className="text-sm text-slate-500">
          Answers cite the exact passages they used. Every candidate passage is re-checked against current sharing before it reaches the model.
        </p>
      </div>
      {error && <ErrorNote message={error} />}
      {!loaded ? (
        <Loading />
      ) : runs.length === 0 ? (
        <Empty>No questions yet.</Empty>
      ) : (
        <ul className="space-y-5" aria-label="Answers">
          {runs.map((r) => (
            <AnswerCard key={r.id} run={r} />
          ))}
        </ul>
      )}
      <div ref={end} />
      <Composer />
    </div>
  )
}
