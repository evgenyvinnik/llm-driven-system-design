/**
 * Agents and knowledge-base documents. Every query names the org and the
 * caller's accessible projects; a resource outside them is simply not found.
 */
import { z } from 'zod'
import { writeAudit } from '../../shared/audit.js'
import { pool, withTransaction } from '../../shared/db.js'
import { asyncHandler, HttpError, notFound } from '../../shared/errors.js'
import { isUuid, uuidParam } from '../../shared/ids.js'
import { accessOf, orgRoutes } from '../../shared/org-access.js'
import type { EffectiveAccess } from '../../shared/access.js'

export const agentsRouter = orgRoutes()

const MODELS = ['relay-small', 'relay-medium', 'relay-large'] as const

function mapAgent(r: Record<string, unknown>) {
  return {
    id: r.id,
    name: r.name,
    model: r.model,
    status: r.status,
    instructions: r.instructions,
    projectId: r.project_id,
    projectName: r.project_name,
    ownerId: r.owner_id,
    ownerName: r.owner_name,
    conversations7d: Number(r.conversations_7d ?? 0),
    updatedAt: r.updated_at,
  }
}

const AGENT_SELECT = `
  SELECT a.id, a.name, a.model, a.status, a.instructions, a.project_id, p.name AS project_name,
         a.owner_id, u.display_name AS owner_name, a.updated_at,
         (SELECT count(*) FROM conversations c
           WHERE c.agent_id = a.id AND c.started_at >= now() - interval '7 days') AS conversations_7d
    FROM agents a
    JOIN projects p ON p.id = a.project_id
    LEFT JOIN users u ON u.id = a.owner_id`

/** A project the caller may write to: one of theirs, in this org. Otherwise 404, like any other resource. */
function assertProject(access: EffectiveAccess, projectId: string): void {
  if (!isUuid(projectId) || !access.projectIds.includes(projectId)) throw notFound('Project')
}

agentsRouter.get(
  '/agents',
  { permission: 'agents.read' },
  asyncHandler(async (req, res) => {
    const access = accessOf(req)
    const { rows } = await pool.query(
      `${AGENT_SELECT} WHERE a.org_id = $1 AND a.project_id = ANY($2::uuid[]) ORDER BY a.updated_at DESC, a.id`,
      [access.orgId, access.projectIds],
    )
    res.json({ agents: rows.map(mapAgent) })
  }),
)

agentsRouter.get(
  '/agents/:agentId',
  { permission: 'agents.read' },
  asyncHandler(async (req, res) => {
    const access = accessOf(req)
    const id = uuidParam(req.params.agentId, 'Agent')
    const { rows } = await pool.query(
      `${AGENT_SELECT} WHERE a.id = $1 AND a.org_id = $2 AND a.project_id = ANY($3::uuid[])`,
      [id, access.orgId, access.projectIds],
    )
    if (!rows[0]) throw notFound('Agent')
    res.json({ agent: mapAgent(rows[0]) })
  }),
)

const createAgentSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    model: z.enum(MODELS),
    projectId: z.string(),
    instructions: z.string().max(4000).default(''),
  })
  .strict()

agentsRouter.post(
  '/agents',
  { permission: 'agents.write' },
  asyncHandler(async (req, res) => {
    const access = accessOf(req)
    const body = createAgentSchema.parse(req.body)
    assertProject(access, body.projectId)
    const agent = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO agents (org_id, project_id, owner_id, name, model, instructions)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [access.orgId, body.projectId, req.user!.id, body.name, body.model, body.instructions],
      )
      await writeAudit(client, {
        orgId: access.orgId,
        actor: req.user!,
        action: 'agent.created',
        targetType: 'agent',
        targetId: rows[0].id,
        targetName: body.name,
        after: { model: body.model, projectId: body.projectId },
      })
      return rows[0]
    })
    res.status(201).json({ agent: { id: agent.id } })
  }),
)

const updateAgentSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    model: z.enum(MODELS).optional(),
    status: z.enum(['draft', 'live', 'paused']).optional(),
    instructions: z.string().max(4000).optional(),
  })
  .strict()

agentsRouter.patch(
  '/agents/:agentId',
  { permission: 'agents.write' },
  asyncHandler(async (req, res) => {
    const access = accessOf(req)
    const id = uuidParam(req.params.agentId, 'Agent')
    const body = updateAgentSchema.parse(req.body)
    const updated = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `SELECT name, model, status, instructions FROM agents
          WHERE id = $1 AND org_id = $2 AND project_id = ANY($3::uuid[]) FOR UPDATE`,
        [id, access.orgId, access.projectIds],
      )
      const before = rows[0]
      if (!before) return null
      const after = { ...before, ...body }
      await client.query(
        `UPDATE agents SET name = $2, model = $3, status = $4, instructions = $5, updated_at = now()
          WHERE id = $1 AND org_id = $6`,
        [id, after.name, after.model, after.status, after.instructions, access.orgId],
      )
      if (body.status && body.status !== before.status) {
        await writeAudit(client, {
          orgId: access.orgId,
          actor: req.user!,
          action: 'agent.status_changed',
          targetType: 'agent',
          targetId: id,
          targetName: after.name,
          before: { status: before.status },
          after: { status: after.status },
        })
      }
      return after
    })
    if (!updated) throw notFound('Agent')
    res.json({ agent: { id, ...updated } })
  }),
)

agentsRouter.delete(
  '/agents/:agentId',
  { permission: 'agents.delete' },
  asyncHandler(async (req, res) => {
    const access = accessOf(req)
    const id = uuidParam(req.params.agentId, 'Agent')
    const deleted = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `DELETE FROM agents WHERE id = $1 AND org_id = $2 AND project_id = ANY($3::uuid[]) RETURNING name, model`,
        [id, access.orgId, access.projectIds],
      )
      if (!rows[0]) return false
      await writeAudit(client, {
        orgId: access.orgId,
        actor: req.user!,
        action: 'agent.deleted',
        targetType: 'agent',
        targetId: id,
        targetName: rows[0].name,
        before: rows[0],
      })
      return true
    })
    if (!deleted) throw notFound('Agent')
    res.status(204).end()
  }),
)

agentsRouter.get(
  '/knowledge',
  { permission: 'knowledge.read' },
  asyncHandler(async (req, res) => {
    const access = accessOf(req)
    const { rows } = await pool.query(
      `SELECT d.id, d.title, d.source, d.chunks, d.status, d.created_at, d.project_id, p.name AS project_name,
              u.display_name AS owner_name
         FROM knowledge_docs d
         JOIN projects p ON p.id = d.project_id
         LEFT JOIN users u ON u.id = d.owner_id
        WHERE d.org_id = $1 AND d.project_id = ANY($2::uuid[])
        ORDER BY d.created_at DESC, d.id`,
      [access.orgId, access.projectIds],
    )
    res.json({
      docs: rows.map((r) => ({
        id: r.id,
        title: r.title,
        source: r.source,
        chunks: r.chunks,
        status: r.status,
        createdAt: r.created_at,
        projectId: r.project_id,
        projectName: r.project_name,
        ownerName: r.owner_name,
      })),
    })
  }),
)

const createDocSchema = z
  .object({
    title: z.string().trim().min(1).max(160),
    source: z.enum(['upload', 'url', 'helpdesk']),
    projectId: z.string(),
  })
  .strict()

agentsRouter.post(
  '/knowledge',
  { permission: 'knowledge.write' },
  asyncHandler(async (req, res) => {
    const access = accessOf(req)
    const body = createDocSchema.parse(req.body)
    assertProject(access, body.projectId)
    const { rows } = await pool.query(
      `INSERT INTO knowledge_docs (org_id, project_id, owner_id, title, source, chunks, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'indexed') RETURNING id`,
      [access.orgId, body.projectId, req.user!.id, body.title, body.source, 12 + (body.title.length % 40)],
    )
    if (!rows[0]) throw new HttpError(500, 'INTERNAL', 'Insert failed')
    res.status(201).json({ doc: { id: rows[0].id } })
  }),
)
