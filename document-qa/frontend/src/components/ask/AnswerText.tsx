/** Answer text with [n] markers turned into links that open the cited span of the source document. */
import { Link } from '@tanstack/react-router'
import type { Citation, SourceRef } from '@/types'

interface Target {
  documentId: string
  versionId: string
  charStart: number
  charEnd: number
  title: string
  quote?: string
}

function targetFor(n: number, nth: number, citations: Citation[], sources: SourceRef[]): Target | null {
  const forN = citations.filter((c) => c.n === n)
  if (forN.length > 0) return forN[Math.min(nth, forN.length - 1)]
  return sources.find((s) => s.n === n) ?? null
}

export function AnswerText({ text, citations, sources, streaming }: { text: string; citations: Citation[]; sources: SourceRef[]; streaming: boolean }) {
  const parts = text.split(/(\[\d+\])/g)
  const seen = new Map<number, number>()
  return (
    <p className="whitespace-pre-wrap text-sm leading-relaxed text-slate-800">
      {parts.map((part, i) => {
        const m = /^\[(\d+)\]$/.exec(part)
        if (!m) return <span key={i}>{part}</span>
        const n = Number(m[1])
        const nth = seen.get(n) ?? 0
        seen.set(n, nth + 1)
        const t = targetFor(n, nth, citations, sources)
        if (!t) return <span key={i} className="cite opacity-50" title="Unknown source">{n}</span>
        return (
          <Link
            key={i}
            to="/documents/$documentId"
            params={{ documentId: t.documentId }}
            search={{ version: t.versionId, start: t.charStart, end: t.charEnd }}
            className="cite"
            title={`${t.title}: characters ${t.charStart}–${t.charEnd}${t.quote ? `\n“${t.quote}”` : ''}`}
            aria-label={`Citation ${n}: ${t.title}`}
          >
            {n}
          </Link>
        )
      })}
      {streaming && <span className="ml-0.5 inline-block h-4 w-1.5 animate-pulse bg-slate-400 align-middle" />}
    </p>
  )
}
