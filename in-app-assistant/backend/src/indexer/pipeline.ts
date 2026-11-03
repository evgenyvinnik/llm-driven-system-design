/**
 * Indexing pipeline for one source: load, clean, chunk, tag with the ACL,
 * embed, and replace the source's chunks. Every step is idempotent, so an
 * event processed twice leaves the same chunks behind.
 * @module indexer/pipeline
 */
import { createHash } from 'node:crypto'
import type { Queryable } from '../shared/db.js'
import { chunkDocument, chunkEmail, type ChunkDraft } from '../retrieval/chunk.js'
import { cleanEmailBody } from '../retrieval/clean.js'
import { embed, toVectorLiteral } from '../retrieval/embed.js'

interface SourceMeta {
  orgId: string
  title: string
  author: string
  authorEmail: string
  date: Date
  isExternal: boolean
}

/** Who may read a message: exactly the users with a mailbox entry for it. */
export async function mailAcl(db: Queryable, messageId: string): Promise<string[]> {
  const { rows } = await db.query<{ user_id: string }>('SELECT user_id FROM mailbox_entries WHERE message_id = $1', [
    messageId,
  ])
  return rows.map((r) => `user:${r.user_id}`).sort()
}

export async function docAcl(db: Queryable, docId: string): Promise<string[]> {
  const { rows } = await db.query<{ principal: string }>(
    `SELECT 'user:' || owner_id AS principal FROM documents WHERE id = $1
     UNION SELECT principal FROM doc_shares WHERE doc_id = $1`,
    [docId],
  )
  return rows.map((r) => r.principal).sort()
}

async function replaceChunks(
  db: Queryable,
  sourceType: 'mail' | 'doc',
  sourceId: string,
  meta: SourceMeta,
  acl: string[],
  drafts: ChunkDraft[],
): Promise<number> {
  await db.query('DELETE FROM chunks WHERE source_type = $1 AND source_id = $2', [sourceType, sourceId])
  for (const draft of drafts) {
    await db.query(
      `INSERT INTO chunks (id, source_type, source_id, org_id, title, author, author_email, source_date, position,
                           anchor, text, acl, is_external, embedding, content_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::vector, $15)`,
      [
        `${sourceType}:${sourceId}:${draft.position}`,
        sourceType,
        sourceId,
        meta.orgId,
        meta.title,
        meta.author,
        meta.authorEmail,
        meta.date,
        draft.position,
        draft.anchor,
        draft.text,
        acl,
        meta.isExternal,
        toVectorLiteral(embed(`${meta.title}\n${draft.text}`)),
        createHash('sha1').update(draft.text).digest('hex'),
      ],
    )
  }
  return drafts.length
}

export async function indexMail(db: Queryable, messageId: string): Promise<number> {
  const { rows } = await db.query<{
    subject: string
    from_name: string
    from_email: string
    sent_at: Date
    body_text: string
    body_html: string | null
    is_external: boolean
  }>('SELECT subject, from_name, from_email, sent_at, body_text, body_html, is_external FROM mail_messages WHERE id = $1', [
    messageId,
  ])
  if (!rows[0]) return deleteSource(db, 'mail', messageId)
  const message = rows[0]
  const acl = await mailAcl(db, messageId)
  if (acl.length === 0) return deleteSource(db, 'mail', messageId)
  const { rows: org } = await db.query<{ org_id: string }>(
    'SELECT u.org_id FROM mailbox_entries e JOIN users u ON u.id = e.user_id WHERE e.message_id = $1 LIMIT 1',
    [messageId],
  )
  const orgId = org[0].org_id
  return replaceChunks(
    db,
    'mail',
    messageId,
    {
      orgId,
      title: message.subject,
      author: message.from_name,
      authorEmail: message.from_email,
      date: message.sent_at,
      isExternal: message.is_external,
    },
    acl,
    chunkEmail(cleanEmailBody(message.body_text, message.body_html)),
  )
}

export async function indexDoc(db: Queryable, docId: string): Promise<number> {
  const { rows } = await db.query<{ title: string; updated_at: Date; display_name: string; email: string; org_id: string }>(
    `SELECT d.title, d.updated_at, u.display_name, u.email, u.org_id
       FROM documents d JOIN users u ON u.id = d.owner_id WHERE d.id = $1`,
    [docId],
  )
  if (!rows[0]) return deleteSource(db, 'doc', docId)
  const doc = rows[0]
  // Suggestions are not content until accepted: pending inserts are skipped
  // and pending replacements keep their original text.
  const { rows: paragraphs } = await db.query<{ id: string; kind: string; text: string }>(
    `SELECT id, kind, text FROM doc_paragraphs
      WHERE doc_id = $1 AND (suggestion IS DISTINCT FROM 'insert') ORDER BY position`,
    [docId],
  )
  return replaceChunks(
    db,
    'doc',
    docId,
    { orgId: doc.org_id, title: doc.title, author: doc.display_name, authorEmail: doc.email, date: doc.updated_at, isExternal: false },
    await docAcl(db, docId),
    chunkDocument(paragraphs),
  )
}

/** Fast path for sharing changes: rewrite the ACL on existing chunks without re-embedding. */
export async function updateAcl(db: Queryable, sourceType: 'mail' | 'doc', sourceId: string): Promise<number> {
  const acl = sourceType === 'mail' ? await mailAcl(db, sourceId) : await docAcl(db, sourceId)
  if (acl.length === 0) return deleteSource(db, sourceType, sourceId)
  const { rowCount } = await db.query('UPDATE chunks SET acl = $3, indexed_at = now() WHERE source_type = $1 AND source_id = $2', [
    sourceType,
    sourceId,
    acl,
  ])
  return rowCount ?? 0
}

export async function deleteSource(db: Queryable, sourceType: 'mail' | 'doc', sourceId: string): Promise<number> {
  await db.query('DELETE FROM chunks WHERE source_type = $1 AND source_id = $2', [sourceType, sourceId])
  return 0
}
