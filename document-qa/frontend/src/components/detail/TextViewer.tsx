/** The version's extracted text; a cited span (start/end offsets) is highlighted and scrolled into view. */
import { useEffect, useRef } from 'react'
import type { DocumentText } from '@/types'

export function TextViewer({ text, highlight }: { text: DocumentText | null; highlight: { start: number; end: number } | null }) {
  const mark = useRef<HTMLElement>(null)
  const body = text?.text ?? null
  const valid = body !== null && highlight !== null && highlight.start >= 0 && highlight.end > highlight.start && highlight.end <= body.length

  useEffect(() => {
    if (valid) mark.current?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [valid, highlight?.start, highlight?.end, text?.versionId])

  return (
    <section aria-label="Document text" className="card flex min-h-0 flex-col">
      <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2">
        <h2 className="panel-title">Extracted text {text ? `· v${text.versionNo}` : ''}</h2>
        {valid && (
          <span className="text-xs text-slate-500">
            highlighting characters {highlight.start}–{highlight.end}
          </span>
        )}
      </div>
      <div className="max-h-[32rem] overflow-y-auto px-4 py-3">
        {body === null ? (
          <p className="text-sm text-slate-500">{text ? `No extracted text for this version (status: ${text.versionStatus}).` : 'Loading…'}</p>
        ) : valid ? (
          <pre className="doc-text">
            {body.slice(0, highlight.start)}
            <mark ref={mark}>{body.slice(highlight.start, highlight.end)}</mark>
            {body.slice(highlight.end)}
          </pre>
        ) : (
          <pre className="doc-text">{body}</pre>
        )}
      </div>
    </section>
  )
}
