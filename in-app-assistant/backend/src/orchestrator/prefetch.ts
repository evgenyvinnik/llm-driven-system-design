/**
 * Optional prefetch: when the request obviously needs the user's data, search
 * before the first model call, so the model can answer without spending a
 * round trip on a search tool call.
 *
 * A small structured-output call rewrites the request (plus earlier turns)
 * into standalone queries and filters: "what did she say about the budget?"
 * becomes a search for "dana budget" from Dana. Passages are packed into a
 * token budget, labeled with their source IDs, and marked as quoted data.
 * @module orchestrator/prefetch
 */
import { hybridSearch, type Passage } from '../retrieval/search.js'
import { pool } from '../shared/db.js'
import { stampIn, zonedTime } from '../shared/time.js'
import { estimateTokens } from '../shared/tokens.js'
import type { Source } from '../tools/types.js'
import { callStructured } from './model-client.js'

const REWRITE_SYSTEM = `Rewrite the user's latest request into standalone search queries over their mail and documents. Resolve pronouns using the earlier conversation. Extract a sender or owner filter and a date range when the request implies one, using the date in <turn_context>. Set needs_retrieval to false when the request doesn't need to look anything up (calendar questions, sending, rewriting selected text).`

const REWRITE_SCHEMA = {
  type: 'object',
  properties: {
    queries: { type: 'array', items: { type: 'string' }, maxItems: 3 },
    sources: { type: 'array', items: { type: 'string', enum: ['mail', 'doc'] } },
    filters: {
      type: 'object',
      properties: {
        from: { type: ['string', 'null'] },
        after: { type: ['string', 'null'] },
        before: { type: ['string', 'null'] },
      },
      required: ['from', 'after', 'before'],
      additionalProperties: false,
    },
    needs_retrieval: { type: 'boolean' },
  },
  required: ['queries', 'sources', 'filters', 'needs_retrieval'],
  additionalProperties: false,
}

interface Rewrite {
  queries: string[]
  sources: ('mail' | 'doc')[]
  filters: { from: string | null; after: string | null; before: string | null }
  needs_retrieval: boolean
}

export interface PrefetchResult {
  block: string
  rewrite: Rewrite
  passages: Passage[]
  sources: Record<string, Source>
  untrusted: boolean
  ms: number
}

const PACK_BUDGET_TOKENS = 1500
const escapeAttr = (value: string) => value.replace(/"/g, "'").replace(/[<>]/g, '')

export async function prefetch(params: {
  userId: string
  orgId: string
  email: string
  timezone: string
  principals: string[]
  turnMessageText: string
  historyText: string
  signal: AbortSignal
}): Promise<PrefetchResult | null> {
  const started = Date.now()
  const rewrite = await callStructured<Rewrite>(
    REWRITE_SYSTEM,
    `${params.historyText ? `<earlier_conversation>\n${params.historyText}\n</earlier_conversation>\n\n` : ''}${params.turnMessageText}`,
    REWRITE_SCHEMA,
    params.signal,
  )
  if (!rewrite || !rewrite.needs_retrieval || rewrite.queries.length === 0) return null
  const toDate = (ymd: string | null) => (ymd && /^\d{4}-\d{2}-\d{2}$/.test(ymd) ? zonedTime(ymd, '00:00', params.timezone) : undefined)
  const seen = new Map<string, Passage>()
  for (const query of rewrite.queries.slice(0, 2)) {
    const { passages } = await hybridSearch({
      userId: params.userId,
      orgId: params.orgId,
      principals: params.principals,
      query,
      sourceTypes: rewrite.sources.length ? rewrite.sources : ['mail', 'doc'],
      from: rewrite.filters.from ?? undefined,
      after: toDate(rewrite.filters.after),
      before: toDate(rewrite.filters.before),
      limit: 4,
    })
    for (const p of passages) if (!seen.has(p.sourceId) || seen.get(p.sourceId)!.score < p.score) seen.set(p.sourceId, p)
  }
  const ranked = [...seen.values()].sort((a, b) => b.score - a.score)
  if (ranked.length === 0) return null

  const mailIds = ranked.filter((p) => p.sourceType === 'mail').map((p) => p.sourceId)
  const { rows } = mailIds.length
    ? await pool.query<{ id: string; thread_id: string }>('SELECT id, thread_id FROM mail_messages WHERE id = ANY($1::text[])', [mailIds])
    : { rows: [] }
  const threadOf = new Map(rows.map((r) => [r.id, r.thread_id]))

  const packed: string[] = []
  const used: Passage[] = []
  const sources: Record<string, Source> = {}
  let tokens = 0
  for (const p of ranked.slice(0, 6)) {
    const id = p.sourceType === 'doc' && p.anchor ? `${p.sourceId}#${p.anchor}` : p.sourceId
    const attrs = [
      `id="${id}"`,
      `kind="${p.sourceType}"`,
      `title="${escapeAttr(p.title)}"`,
      `from="${escapeAttr(`${p.author} <${p.authorEmail}>`)}"`,
      `date="${stampIn(p.date, params.timezone)}"`,
      ...(threadOf.get(p.sourceId) ? [`thread="${threadOf.get(p.sourceId)}"`] : []),
    ]
    const passage = `<passage ${attrs.join(' ')}>\n${p.text}\n</passage>`
    if (tokens + estimateTokens(passage) > PACK_BUDGET_TOKENS) break
    tokens += estimateTokens(passage)
    packed.push(passage)
    used.push(p)
    sources[id] =
      p.sourceType === 'mail'
        ? { id, kind: 'mail', title: p.title, subtitle: p.author, href: `/mail?m=${p.sourceId}` }
        : { id, kind: 'doc', title: p.title, subtitle: p.author, href: `/docs/${p.sourceId}${p.anchor ? `?p=${p.anchor}` : ''}` }
    if (p.sourceType === 'doc') sources[p.sourceId] ??= { ...sources[id], id: p.sourceId, href: `/docs/${p.sourceId}` }
  }
  return {
    block: packed.join('\n'),
    rewrite,
    passages: used,
    sources,
    untrusted: used.some((p) => p.isExternal || p.authorEmail !== params.email),
    ms: Date.now() - started,
  }
}
