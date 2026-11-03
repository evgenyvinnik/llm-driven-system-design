/**
 * Host app: documents, paragraphs, tracked suggestions and sharing. Every
 * content change and every sharing change goes into the index outbox in the
 * same transaction; sharing changes use the fast lane.
 */
import { Router } from 'express'
import { z } from 'zod'
import { requireAuth } from '../../shared/auth.js'
import { pool, withTransaction } from '../../shared/db.js'
import { asyncHandler, HttpError } from '../../shared/errors.js'
import { idParam } from '../../shared/ids.js'
import { enqueueIndexEvent } from '../../shared/outbox.js'
import { principalsFor } from '../../retrieval/principals.js'
import { docAccess, type DocAccess } from '../../tools/docs.js'

export const docsRouter = Router()
docsRouter.use(requireAuth)

async function access(req: Express.Request, docId: string, needEdit = false): Promise<DocAccess> {
  const principals = await principalsFor(pool, req.user!.id, req.user!.orgId)
  const doc = await docAccess(pool, docId, req.user!.id, principals)
  if (!doc) throw new HttpError(404, 'NOT_FOUND', 'Document not found')
  if (needEdit && doc.role === 'viewer') throw new HttpError(403, 'READ_ONLY', 'You can view this document but not edit it')
  return doc
}

docsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const principals = await principalsFor(pool, req.user!.id, req.user!.orgId)
    const { rows } = await pool.query<{ id: string; title: string; owner_id: string; display_name: string; updated_at: Date; role: string | null }>(
      `SELECT d.id, d.title, d.owner_id, u.display_name, d.updated_at,
              CASE WHEN d.owner_id = $1 THEN 'owner'
                   ELSE (SELECT CASE WHEN bool_or(role = 'editor') THEN 'editor' ELSE 'viewer' END
                           FROM doc_shares s WHERE s.doc_id = d.id AND s.principal = ANY($2::text[])) END AS role
         FROM documents d JOIN users u ON u.id = d.owner_id
        WHERE d.owner_id = $1 OR EXISTS (SELECT 1 FROM doc_shares s WHERE s.doc_id = d.id AND s.principal = ANY($2::text[]))
        ORDER BY d.updated_at DESC`,
      [req.user!.id, principals],
    )
    res.json({ documents: rows.map((r) => ({ id: r.id, title: r.title, owner: r.display_name, ownerId: r.owner_id, role: r.role, updatedAt: r.updated_at.toISOString() })) })
  }),
)

async function documentPayload(doc: DocAccess) {
  const { rows } = await pool.query<{ id: string; kind: string; text: string; suggestion: string | null; suggested_text: string | null; suggested_by: string | null }>(
    'SELECT id, kind, text, suggestion, suggested_text, suggested_by FROM doc_paragraphs WHERE doc_id = $1 ORDER BY position',
    [doc.id],
  )
  const { rows: shares } = doc.role === 'owner' ? await pool.query<{ principal: string; role: string }>('SELECT principal, role FROM doc_shares WHERE doc_id = $1 ORDER BY principal', [doc.id]) : { rows: [] }
  const { rows: version } = await pool.query<{ version: number }>('SELECT version FROM documents WHERE id = $1', [doc.id])
  return {
    document: {
      id: doc.id,
      title: doc.title,
      owner: doc.ownerName,
      role: doc.role,
      version: version[0].version,
      paragraphs: rows.map((p) => ({ id: p.id, kind: p.kind, text: p.text, suggestion: p.suggestion, suggestedText: p.suggested_text, suggestedBy: p.suggested_by })),
      shares: shares.map((s) => ({ principal: s.principal, role: s.role })),
    },
  }
}

docsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    res.json(await documentPayload(await access(req, idParam(req.params.id, 'doc', 'Document'))))
  }),
)

const editSchema = z.object({ text: z.string().min(1).max(8000), baseVersion: z.number().int() })

docsRouter.patch(
  '/:id/paragraphs/:pid',
  asyncHandler(async (req, res) => {
    const doc = await access(req, idParam(req.params.id, 'doc', 'Document'), true)
    const { text, baseVersion } = editSchema.parse(req.body)
    await withTransaction(async (client) => {
      const { rows } = await client.query<{ version: number }>('SELECT version FROM documents WHERE id = $1 FOR UPDATE', [doc.id])
      // Optimistic concurrency: an edit based on an older version is refused, and the client reloads.
      if (rows[0].version !== baseVersion) throw new HttpError(409, 'VERSION_CONFLICT', 'The document changed; reload and try again', { version: rows[0].version })
      const { rowCount } = await client.query('UPDATE doc_paragraphs SET text = $3 WHERE doc_id = $1 AND id = $2', [doc.id, req.params.pid, text])
      if (!rowCount) throw new HttpError(404, 'NOT_FOUND', 'Paragraph not found')
      await client.query('UPDATE documents SET version = version + 1, updated_at = now() WHERE id = $1', [doc.id])
      await enqueueIndexEvent(client, 'doc', doc.id, 'upsert')
    })
    res.json(await documentPayload(doc))
  }),
)

for (const decision of ['accept', 'reject'] as const) {
  docsRouter.post(
    `/:id/paragraphs/:pid/${decision}`,
    asyncHandler(async (req, res) => {
      const doc = await access(req, idParam(req.params.id, 'doc', 'Document'), true)
      await withTransaction(async (client) => {
        const { rows } = await client.query<{ suggestion: string | null; suggested_by: string | null; suggestion_turn_id: string | null }>(
          'SELECT suggestion, suggested_by, suggestion_turn_id FROM doc_paragraphs WHERE doc_id = $1 AND id = $2 FOR UPDATE',
          [doc.id, req.params.pid],
        )
        const suggestion = rows[0]?.suggestion
        if (!suggestion) throw new HttpError(409, 'NO_SUGGESTION', 'This paragraph has no pending suggestion')
        if (rows[0].suggested_by === 'assistant') {
          await client.query('INSERT INTO assistant_feedback (user_id, turn_id, kind, subject) VALUES ($1, $2, $3, $4)', [
            req.user!.id,
            rows[0].suggestion_turn_id,
            decision === 'accept' ? 'edit_kept' : 'edit_undone',
            `${doc.id}#${req.params.pid}`,
          ])
        }
        if (decision === 'accept') {
          await client.query(
            `UPDATE doc_paragraphs SET text = CASE WHEN suggestion = 'replace' THEN suggested_text ELSE text END,
                    suggestion = NULL, suggested_text = NULL, suggested_by = NULL, suggestion_turn_id = NULL
              WHERE doc_id = $1 AND id = $2`,
            [doc.id, req.params.pid],
          )
        } else if (suggestion === 'insert') {
          await client.query('DELETE FROM doc_paragraphs WHERE doc_id = $1 AND id = $2', [doc.id, req.params.pid])
        } else {
          await client.query('UPDATE doc_paragraphs SET suggestion = NULL, suggested_text = NULL, suggested_by = NULL, suggestion_turn_id = NULL WHERE doc_id = $1 AND id = $2', [doc.id, req.params.pid])
        }
        await client.query('UPDATE documents SET version = version + 1, updated_at = now() WHERE id = $1', [doc.id])
        await enqueueIndexEvent(client, 'doc', doc.id, 'upsert')
      })
      res.json(await documentPayload(doc))
    }),
  )
}

const shareSchema = z.object({ principal: z.string().regex(/^(user|group|org):[a-z0-9_]+$/), role: z.enum(['viewer', 'editor']).nullable() })

docsRouter.put(
  '/:id/shares',
  asyncHandler(async (req, res) => {
    const doc = await access(req, idParam(req.params.id, 'doc', 'Document'))
    if (doc.role !== 'owner') throw new HttpError(403, 'FORBIDDEN', 'Only the owner can change sharing')
    const { principal, role } = shareSchema.parse(req.body)
    await withTransaction(async (client) => {
      if (role) {
        await client.query('INSERT INTO doc_shares (doc_id, principal, role) VALUES ($1, $2, $3) ON CONFLICT (doc_id, principal) DO UPDATE SET role = EXCLUDED.role', [doc.id, principal, role])
      } else {
        await client.query('DELETE FROM doc_shares WHERE doc_id = $1 AND principal = $2', [doc.id, principal])
      }
      // Permission changes take the fast lane: a stale ACL in the index is a leak.
      await enqueueIndexEvent(client, 'doc', doc.id, 'acl')
    })
    res.json(await documentPayload(doc))
  }),
)
