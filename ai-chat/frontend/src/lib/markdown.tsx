/**
 * Safe, incremental markdown rendering for model output.
 *
 * Safety comes from never producing HTML. marked is used only as a lexer;
 * its tokens are turned into React elements here, so every string reaches the
 * DOM as text (React escapes it) and there is no dangerouslySetInnerHTML and
 * no sanitizer to keep up to date. Specifically:
 *   - raw HTML in the output (<script>, <img onerror>) is shown as literal text;
 *   - links are allowed only for http(s) and mailto, open in a new tab with
 *     rel="noopener noreferrer nofollow", and show their real host;
 *   - images are never fetched. A markdown image is a classic exfiltration
 *     channel for prompt injection (the URL carries the stolen data, and the
 *     browser sends it the moment it renders), so it becomes a labelled link.
 *
 * Streaming cost: the text is split into top-level blocks, and each block is
 * a memoized component keyed by position and compared by its source text.
 * While an answer streams, only its last block changes, so only the last
 * block re-renders; everything above it is skipped by React. Re-lexing the
 * whole answer per frame is a few hundred microseconds for typical lengths.
 */
import type { Token, Tokens } from 'marked'
import { memo, useMemo, useState, type ReactNode } from 'react'
import { decode, lexBlocks, safeUrl } from './markdown-utils'

function Inline({ tokens }: { tokens: Token[] | undefined }): ReactNode {
  if (!tokens) return null
  return tokens.map((token, i) => <InlineToken key={i} token={token} />)
}

function InlineToken({ token }: { token: Token }): ReactNode {
  switch (token.type) {
    case 'text': {
      const t = token as Tokens.Text
      return t.tokens ? <Inline tokens={t.tokens} /> : decode(t.text)
    }
    case 'escape':
      return decode((token as Tokens.Escape).text)
    case 'strong':
      return (
        <strong>
          <Inline tokens={(token as Tokens.Strong).tokens} />
        </strong>
      )
    case 'em':
      return (
        <em>
          <Inline tokens={(token as Tokens.Em).tokens} />
        </em>
      )
    case 'del':
      return (
        <del>
          <Inline tokens={(token as Tokens.Del).tokens} />
        </del>
      )
    case 'codespan':
      return <code>{decode((token as Tokens.Codespan).text)}</code>
    case 'br':
      return <br />
    case 'link': {
      const t = token as Tokens.Link
      const url = safeUrl(t.href)
      if (!url) {
        return (
          <span className="text-slate-500" title="Link removed: only http, https and mailto links are allowed">
            <Inline tokens={t.tokens} />
          </span>
        )
      }
      return (
        <a href={url.href} target="_blank" rel="noopener noreferrer nofollow ugc" title={url.href}>
          <Inline tokens={t.tokens} />
          {url.protocol !== 'mailto:' && <span className="ml-1 text-xs text-slate-400 no-underline">({url.host})</span>}
        </a>
      )
    }
    case 'image': {
      const t = token as Tokens.Image
      const url = safeUrl(t.href)
      // Never <img>: loading it would send the URL (and anything encoded in it) to that host.
      return (
        <span className="chip bg-slate-100 text-slate-600" data-blocked-image="">
          Image not loaded: {t.text || 'untitled'}
          {url ? ` (${url.host})` : ''}
        </span>
      )
    }
    case 'html':
      return <code className="text-slate-500">{(token as Tokens.HTML).text}</code>
    default: {
      const t = token as { tokens?: Token[]; text?: string; raw: string }
      return t.tokens ? <Inline tokens={t.tokens} /> : decode(t.text ?? t.raw)
    }
  }
}

function CodeBlock({ token }: { token: Tokens.Code }) {
  const [copied, setCopied] = useState(false)
  const copy = () => {
    void navigator.clipboard?.writeText(token.text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }
  return (
    <div className="relative">
      <div className="flex items-center justify-between rounded-t-md bg-slate-800 px-3 py-1 text-xs text-slate-300">
        <span>{token.lang || 'code'}</span>
        <button type="button" onClick={copy} className="hover:text-white">
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="!mt-0 !rounded-t-none">
        <code>{token.text}</code>
      </pre>
    </div>
  )
}

function ListBlock({ token }: { token: Tokens.List }) {
  const items = token.items.map((item, i) => (
    <li key={i}>
      {item.task && <input type="checkbox" checked={!!item.checked} disabled className="mr-1.5 align-middle" />}
      {item.tokens.map((child, j) =>
        // Tight lists wrap inline content in a bare text token; loose lists use paragraphs.
        child.type === 'text' ? <InlineToken key={j} token={child} /> : <BlockToken key={j} token={child} />,
      )}
    </li>
  ))
  if (token.ordered) {
    const start = typeof token.start === 'number' ? token.start : undefined
    return <ol start={start}>{items}</ol>
  }
  return <ul>{items}</ul>
}

function TableBlock({ token }: { token: Tokens.Table }) {
  const align = (i: number) => token.align[i] ?? undefined
  return (
    <div className="overflow-x-auto">
      <table>
        <thead>
          <tr>
            {token.header.map((cell, i) => (
              <th key={i} style={{ textAlign: align(i) }}>
                <Inline tokens={cell.tokens} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {token.rows.map((row, r) => (
            <tr key={r}>
              {row.map((cell, i) => (
                <td key={i} style={{ textAlign: align(i) }}>
                  <Inline tokens={cell.tokens} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function BlockToken({ token }: { token: Token }): ReactNode {
  switch (token.type) {
    case 'heading': {
      const t = token as Tokens.Heading
      const level = Math.min(Math.max(t.depth, 1), 4)
      const content = <Inline tokens={t.tokens} />
      if (level === 1) return <h1>{content}</h1>
      if (level === 2) return <h2>{content}</h2>
      if (level === 3) return <h3>{content}</h3>
      return <h4>{content}</h4>
    }
    case 'paragraph':
      return (
        <p>
          <Inline tokens={(token as Tokens.Paragraph).tokens} />
        </p>
      )
    case 'code':
      return <CodeBlock token={token as Tokens.Code} />
    case 'list':
      return <ListBlock token={token as Tokens.List} />
    case 'blockquote':
      return (
        <blockquote>
          {(token as Tokens.Blockquote).tokens.map((child, i) => (
            <BlockToken key={i} token={child} />
          ))}
        </blockquote>
      )
    case 'table':
      return <TableBlock token={token as Tokens.Table} />
    case 'hr':
      return <hr />
    case 'html':
      // Raw HTML from the model is displayed, never interpreted.
      return (
        <pre className="!bg-slate-100 !text-slate-600" data-raw-html="">
          <code>{(token as Tokens.HTML).text.trimEnd()}</code>
        </pre>
      )
    case 'text': {
      const t = token as Tokens.Text
      return <p>{t.tokens ? <Inline tokens={t.tokens} /> : decode(t.text)}</p>
    }
    default: {
      const t = token as { text?: string; raw: string }
      return <p>{decode(t.text ?? t.raw)}</p>
    }
  }
}

/** One top-level block. Skips re-rendering unless its own source text changed. */
const Block = memo(
  function Block({ token }: { token: Token }) {
    return <BlockToken token={token} />
  },
  (prev, next) => prev.token.raw === next.token.raw,
)

export function Markdown({ text }: { text: string }) {
  const blocks = useMemo(() => lexBlocks(text), [text])
  return (
    <div className="md">
      {blocks.map((token, i) => (
        <Block key={i} token={token} />
      ))}
    </div>
  )
}
