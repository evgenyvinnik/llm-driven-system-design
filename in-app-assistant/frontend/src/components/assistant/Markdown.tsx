/**
 * Renders the small markdown subset the assistant uses (paragraphs, lists,
 * bold, inline code) plus citation chips, as React elements. There is no
 * HTML parsing and no dangerouslySetInnerHTML, so model output can't inject
 * markup or script; markdown links are shown as text, and the only clickable
 * things are citations that resolve to items the tools returned.
 * Half-finished syntax while streaming simply shows as text until it closes.
 */
import { Fragment, type ReactNode } from 'react'
import type { Citation } from '@/types'
import { CitationChip } from './CitationChip'

const INLINE = /(\*\*[^*\n]+\*\*|`[^`\n]+`|\[(?:m|doc|ev|dr|t)_[a-z0-9]+(?:#p_\d+)?\])/g

function inline(text: string, citations: Map<string, Citation>, final: boolean, key: string): ReactNode[] {
  return text.split(INLINE).map((part, i) => {
    const k = `${key}-${i}`
    if (/^\*\*[^*]+\*\*$/.test(part)) return <strong key={k}>{part.slice(2, -2)}</strong>
    if (/^`[^`]+`$/.test(part)) return <code key={k} className="rounded bg-slate-100 px-1 font-mono text-[12px]">{part.slice(1, -1)}</code>
    const cite = /^\[(.+)\]$/.exec(part)
    if (cite && /^(m|doc|ev|dr|t)_/.test(cite[1])) return <CitationChip key={k} id={cite[1]} citation={citations.get(cite[1])} final={final} />
    return <Fragment key={k}>{part}</Fragment>
  })
}

export function Markdown({ text, citations = [], final = false }: { text: string; citations?: Citation[]; final?: boolean }) {
  const map = new Map(citations.map((c) => [c.id, c]))
  const blocks = text.split(/\n{2,}/)
  return (
    <div className="space-y-2 text-[13.5px] leading-relaxed text-slate-800">
      {blocks.map((block, b) => {
        const lines = block.split('\n').filter((l) => l.trim())
        if (lines.length && lines.every((l) => /^\s*[-*] /.test(l))) {
          return (
            <ul key={b} className="list-disc space-y-1 pl-5">
              {lines.map((l, i) => <li key={i}>{inline(l.replace(/^\s*[-*] /, ''), map, final, `${b}-${i}`)}</li>)}
            </ul>
          )
        }
        if (lines.length && lines.every((l) => /^\s*\d+\. /.test(l))) {
          return (
            <ol key={b} className="list-decimal space-y-1 pl-5">
              {lines.map((l, i) => <li key={i}>{inline(l.replace(/^\s*\d+\. /, ''), map, final, `${b}-${i}`)}</li>)}
            </ol>
          )
        }
        if (/^#{1,6} /.test(block)) return <p key={b} className="font-semibold">{inline(block.replace(/^#{1,6} /, ''), map, final, `${b}`)}</p>
        return (
          <p key={b}>
            {lines.map((l, i) => (
              <Fragment key={i}>
                {i > 0 && <br />}
                {inline(l, map, final, `${b}-${i}`)}
              </Fragment>
            ))}
          </p>
        )
      })}
    </div>
  )
}
