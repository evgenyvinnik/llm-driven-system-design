/**
 * Document tools. Paragraph IDs are stable, so the model edits by ID
 * ("after p_3") rather than by character offsets it would have to count.
 * Edits default to tracked suggestions, which the user can accept or reject;
 * a direct edit can't be undone from the assistant's side and needs
 * confirmation.
 * @module tools/docs
 */
import { hybridSearch } from '../retrieval/search.js'
import type { Queryable } from '../shared/db.js'
import { enqueueIndexEvent } from '../shared/outbox.js'
import { stampIn } from '../shared/time.js'
import { ToolError, type ToolContext, type ToolSpec } from './types.js'

export interface DocAccess {
  id: string
  title: string
  ownerId: string
  ownerName: string
  version: number
  role: 'owner' | 'editor' | 'viewer'
}

/** The authoritative permission check, against the source tables (never the index). */
export async function docAccess(db: Queryable, docId: string, userId: string, principals: string[]): Promise<DocAccess | null> {
  const { rows } = await db.query<{ id: string; title: string; owner_id: string; display_name: string; version: number; role: string | null }>(
    `SELECT d.id, d.title, d.owner_id, u.display_name, d.version,
            CASE WHEN d.owner_id = $2 THEN 'owner'
                 ELSE (SELECT CASE WHEN bool_or(role = 'editor') THEN 'editor' ELSE 'viewer' END
                         FROM doc_shares WHERE doc_id = d.id AND principal = ANY($3::text[])) END AS role
       FROM documents d JOIN users u ON u.id = d.owner_id
      WHERE d.id = $1`,
    [docId, userId, principals],
  )
  const row = rows[0]
  if (!row || !row.role) return null
  return { id: row.id, title: row.title, ownerId: row.owner_id, ownerName: row.display_name, version: row.version, role: row.role as DocAccess['role'] }
}

async function requireDoc(ctx: ToolContext, docId: unknown, needEdit: boolean): Promise<DocAccess> {
  const access = await docAccess(ctx.db, String(docId), ctx.userId, ctx.principals)
  if (!access) throw new ToolError(`No document with id ${docId} that this user can open. Find document ids with search_docs.`)
  if (needEdit && access.role === 'viewer') {
    throw new ToolError(`The user can view "${access.title}" but not edit it. Tell them they need edit access from ${access.ownerName}; don't retry.`)
  }
  return access
}

const docSource = (doc: { id: string; title: string }, paragraph: string | null, subtitle?: string) => ({
  id: paragraph ? `${doc.id}#${paragraph}` : doc.id,
  kind: 'doc' as const,
  title: doc.title,
  subtitle,
  href: `/docs/${doc.id}${paragraph ? `?p=${paragraph}` : ''}`,
})

export const searchDocs: ToolSpec = {
  name: 'search_docs',
  description:
    "Find documents the user owns or that were shared with them, by keywords and optionally by owner. Returns the best-matching passage of each document with its doc_id, title, owner, the paragraph_id where the passage starts, and whether the user can edit it. Use read_document to see the whole document.",
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', minLength: 1, description: "Keywords, e.g. 'travel budget forecast'" },
      owner: { type: 'string', description: 'Owner name or email, e.g. "dana"' },
      limit: { type: 'integer', minimum: 1, maximum: 10, default: 5 },
    },
    required: ['query'],
    additionalProperties: false,
  },
  apps: ['mail', 'docs', 'calendar'],
  execution: 'server',
  effect: 'read',
  reversible: true,
  timeoutMs: 5000,
  statusLabel: () => 'Searching your documents…',
  async run(args, ctx) {
    const { passages, stats } = await hybridSearch(
      {
        userId: ctx.userId,
        orgId: ctx.orgId,
        principals: ctx.principals,
        query: String(args.query),
        sourceTypes: ['doc'],
        from: args.owner as string | undefined,
        limit: Number(args.limit ?? 5),
      },
      ctx.db,
    )
    const results = []
    for (const p of passages) {
      const access = await docAccess(ctx.db, p.sourceId, ctx.userId, ctx.principals)
      if (!access) continue
      results.push({
        doc_id: p.sourceId,
        title: p.title,
        owner: p.author,
        updated: stampIn(p.date, ctx.timezone),
        paragraph_id: p.anchor,
        snippet: p.text.replace(/\s+/g, ' ').slice(0, 260),
        can_edit: access.role !== 'viewer',
      })
    }
    return {
      content: results.length ? { results } : { results, note: 'No matching documents. Try different keywords.' },
      untrusted: passages.some((p) => p.authorEmail !== ctx.email),
      sources: results.map((r) => docSource({ id: r.doc_id, title: r.title }, r.paragraph_id ?? null, r.owner)),
      summary: `${results.length} document${results.length === 1 ? '' : 's'} (keyword ${stats.keyword}, vector ${stats.vector})`,
    }
  },
}

const PAGE = 25

export const readDocument: ToolSpec = {
  name: 'read_document',
  description:
    'Read a document as a list of paragraphs, each with a stable paragraph id (p_1, p_2, ...) that insert_text and replace_text accept. detail "outline" returns headings and the start of each paragraph; "full" returns full text, 25 paragraphs per page, with next_cursor when there is more. Pending suggestions are marked.',
  inputSchema: {
    type: 'object',
    properties: {
      doc_id: { type: 'string', pattern: '^doc_[a-z0-9]+$' },
      detail: { type: 'string', enum: ['outline', 'full'], default: 'full' },
      cursor: { type: 'string', description: 'next_cursor from a previous call' },
    },
    required: ['doc_id'],
    additionalProperties: false,
  },
  apps: ['mail', 'docs', 'calendar'],
  execution: 'server',
  effect: 'read',
  reversible: true,
  timeoutMs: 3000,
  statusLabel: () => 'Reading the document…',
  async run(args, ctx) {
    const doc = await requireDoc(ctx, args.doc_id, false)
    const offset = typeof args.cursor === 'string' && /^\d+$/.test(args.cursor) ? Number(args.cursor) : 0
    const { rows } = await ctx.db.query<{ id: string; kind: string; text: string; suggestion: string | null; suggested_text: string | null }>(
      'SELECT id, kind, text, suggestion, suggested_text FROM doc_paragraphs WHERE doc_id = $1 ORDER BY position',
      [doc.id],
    )
    const outline = args.detail === 'outline'
    const page = outline ? rows : rows.slice(offset, offset + PAGE)
    return {
      content: {
        doc_id: doc.id,
        title: doc.title,
        owner: doc.ownerName,
        version: doc.version,
        can_edit: doc.role !== 'viewer',
        paragraphs: page.map((p) => ({
          id: p.id,
          kind: p.kind,
          text: outline && p.kind !== 'heading' && p.text.length > 80 ? `${p.text.slice(0, 80)}…` : p.text,
          ...(p.suggestion === 'insert' ? { pending_suggestion: 'insert' } : {}),
          ...(p.suggestion === 'replace' ? { pending_suggestion: 'replace', suggested_text: p.suggested_text } : {}),
        })),
        ...(!outline && offset + PAGE < rows.length ? { next_cursor: String(offset + PAGE) } : {}),
      },
      untrusted: doc.ownerId !== ctx.userId,
      sources: [docSource(doc, null, doc.ownerName)],
      summary: `"${doc.title}", ${page.length} paragraph${page.length === 1 ? '' : 's'}`,
    }
  },
}

function toParagraphs(text: string): { kind: 'body' | 'bullet'; text: string }[] {
  return text
    .split(/\n{2,}/)
    .flatMap((block) => (block.split('\n').every((l) => /^\s*[-*] /.test(l)) ? block.split('\n') : [block]))
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => (/^[-*] /.test(block) ? { kind: 'bullet' as const, text: block.slice(2).trim() } : { kind: 'body' as const, text: block }))
}

export const insertText: ToolSpec = {
  name: 'insert_text',
  description:
    'Insert new paragraphs into a document after an existing paragraph. Separate paragraphs with a blank line; lines starting with "- " become bullets. mode "tracked" (the default) adds them as suggestions the user can accept or reject; "direct" edits the document outright and needs the user\'s confirmation. Returns the new paragraph ids and the document version.',
  inputSchema: {
    type: 'object',
    properties: {
      doc_id: { type: 'string', pattern: '^doc_[a-z0-9]+$' },
      after_paragraph_id: { type: 'string', pattern: '^p_[0-9]+$', description: 'Insert after this paragraph, e.g. "p_3"' },
      text: { type: 'string', minLength: 1, maxLength: 8000 },
      mode: { type: 'string', enum: ['tracked', 'direct'], default: 'tracked' },
    },
    required: ['doc_id', 'after_paragraph_id', 'text'],
    additionalProperties: false,
  },
  apps: ['docs'],
  execution: 'server',
  effect: 'write',
  reversible: (args) => args.mode !== 'direct',
  setting: 'allow_doc_edits',
  timeoutMs: 3000,
  statusLabel: () => 'Adding text to the document…',
  async inspect(args, ctx) {
    const doc = await requireDoc(ctx, args.doc_id, false)
    return {
      externalRecipients: [],
      title: `${args.mode === 'direct' ? 'Edit' : 'Suggest an edit to'} "${doc.title}"`,
      preview: { kind: 'doc_insert', doc_id: doc.id, title: doc.title, after: args.after_paragraph_id, text: args.text, mode: args.mode ?? 'tracked' },
    }
  },
  async run(args, ctx) {
    const doc = await requireDoc(ctx, args.doc_id, true)
    const { rows } = await ctx.db.query<{ position: number }>('SELECT position FROM doc_paragraphs WHERE doc_id = $1 AND id = $2', [
      doc.id,
      args.after_paragraph_id,
    ])
    if (!rows[0]) throw new ToolError(`No paragraph ${args.after_paragraph_id} in ${doc.id}. Call read_document to get the current paragraph ids.`)
    const after = rows[0].position
    const { rows: next } = await ctx.db.query<{ position: number }>(
      'SELECT position FROM doc_paragraphs WHERE doc_id = $1 AND position > $2 ORDER BY position LIMIT 1',
      [doc.id, after],
    )
    const ceiling = next[0]?.position ?? after + 1000
    const paragraphs = toParagraphs(String(args.text))
    const { rows: counter } = await ctx.db.query<{ next_pid: number; version: number }>(
      'UPDATE documents SET next_pid = next_pid + $2, version = version + 1, updated_at = now() WHERE id = $1 RETURNING next_pid, version',
      [doc.id, paragraphs.length],
    )
    const firstPid = counter[0].next_pid - paragraphs.length
    const tracked = args.mode !== 'direct'
    const inserted: string[] = []
    for (const [i, paragraph] of paragraphs.entries()) {
      const id = `p_${firstPid + i}`
      const position = after + ((ceiling - after) * (i + 1)) / (paragraphs.length + 1)
      await ctx.db.query(
        `INSERT INTO doc_paragraphs (doc_id, id, position, kind, text, suggestion, suggested_by, suggestion_turn_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [doc.id, id, position, paragraph.kind, paragraph.text, tracked ? 'insert' : null, tracked ? 'assistant' : null, tracked ? ctx.turnId : null],
      )
      inserted.push(id)
    }
    if (!tracked) await enqueueIndexEvent(ctx.db, 'doc', doc.id, 'upsert')
    return {
      content: {
        inserted,
        doc_version: counter[0].version,
        mode: tracked ? 'tracked' : 'direct',
        ...(tracked ? { note: 'Added as suggestions; the user can accept or reject them.' } : {}),
      },
      sources: [docSource(doc, inserted[0])],
      summary: `${inserted.length} paragraph${inserted.length === 1 ? '' : 's'} ${tracked ? 'suggested' : 'inserted'} after ${args.after_paragraph_id}`,
    }
  },
}

export const replaceText: ToolSpec = {
  name: 'replace_text',
  description:
    'Replace the text of one paragraph. mode "tracked" (the default) shows the new text as a suggestion next to the old; "direct" overwrites it and needs the user\'s confirmation. Use paragraph ids from read_document or get_selection.',
  inputSchema: {
    type: 'object',
    properties: {
      doc_id: { type: 'string', pattern: '^doc_[a-z0-9]+$' },
      paragraph_id: { type: 'string', pattern: '^p_[0-9]+$' },
      text: { type: 'string', minLength: 1, maxLength: 4000 },
      mode: { type: 'string', enum: ['tracked', 'direct'], default: 'tracked' },
    },
    required: ['doc_id', 'paragraph_id', 'text'],
    additionalProperties: false,
  },
  apps: ['docs'],
  execution: 'server',
  effect: 'write',
  reversible: (args) => args.mode !== 'direct',
  setting: 'allow_doc_edits',
  timeoutMs: 3000,
  statusLabel: () => 'Suggesting a rewrite…',
  async inspect(args, ctx) {
    const doc = await requireDoc(ctx, args.doc_id, false)
    return {
      externalRecipients: [],
      title: `${args.mode === 'direct' ? 'Rewrite' : 'Suggest a rewrite of'} ${args.paragraph_id} in "${doc.title}"`,
      preview: { kind: 'doc_replace', doc_id: doc.id, title: doc.title, paragraph_id: args.paragraph_id, text: args.text, mode: args.mode ?? 'tracked' },
    }
  },
  async run(args, ctx) {
    const doc = await requireDoc(ctx, args.doc_id, true)
    const tracked = args.mode !== 'direct'
    const { rowCount } = await ctx.db.query(
      tracked
        ? `UPDATE doc_paragraphs SET suggestion = COALESCE(suggestion, 'replace'), suggested_text = $3, suggested_by = 'assistant', suggestion_turn_id = $4
            WHERE doc_id = $1 AND id = $2`
        : `UPDATE doc_paragraphs SET text = $3 WHERE doc_id = $1 AND id = $2 AND $4::uuid IS NOT NULL`,
      [doc.id, args.paragraph_id, args.text, ctx.turnId],
    )
    if (!rowCount) throw new ToolError(`No paragraph ${args.paragraph_id} in ${doc.id}. Call read_document to get the current paragraph ids.`)
    const { rows } = await ctx.db.query<{ version: number }>(
      'UPDATE documents SET version = version + 1, updated_at = now() WHERE id = $1 RETURNING version',
      [doc.id],
    )
    if (!tracked) await enqueueIndexEvent(ctx.db, 'doc', doc.id, 'upsert')
    return {
      content: { paragraph_id: args.paragraph_id, doc_version: rows[0].version, mode: tracked ? 'tracked' : 'direct' },
      sources: [docSource(doc, String(args.paragraph_id))],
      summary: `${args.paragraph_id} ${tracked ? 'rewrite suggested' : 'rewritten'}`,
    }
  },
}
