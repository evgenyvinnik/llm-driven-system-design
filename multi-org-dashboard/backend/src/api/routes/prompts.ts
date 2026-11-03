/**
 * Prompt library, the prompt-sharing variant. A prompt is visible to its
 * owner and to the roles listed in shared_roles; a share link is a separate,
 * revocable bearer grant on top. Visibility is a WHERE clause, not a check
 * after the fact, so a list can never include a prompt the caller can't open.
 */
import { z } from 'zod'
import { writeAudit } from '../../shared/audit.js'
import { pool, withTransaction } from '../../shared/db.js'
import { asyncHandler, HttpError, notFound } from '../../shared/errors.js'
import { hashToken, isUuid, newToken, uuidParam } from '../../shared/ids.js'
import { accessOf, orgRoutes } from '../../shared/org-access.js'
import { ROLES } from '../../shared/permissions.js'
import type { EffectiveAccess } from '../../shared/access.js'

export const promptsRouter = orgRoutes()

const FLAG = 'prompt_library'

/** $1 org, $2 projects, $3 user, $4 role: the caller can see the prompt. */
const VISIBLE = `p.org_id = $1 AND p.project_id = ANY($2::uuid[]) AND (p.owner_id = $3 OR $4 = ANY(p.shared_roles))`
const visibleParams = (access: EffectiveAccess) => [access.orgId, access.projectIds, access.userId, access.role]

function mapPrompt(r: Record<string, unknown>, access: EffectiveAccess) {
  return {
    id: r.id,
    title: r.title,
    body: r.body,
    sharedRoles: r.shared_roles,
    activeLinks: Number(r.active_links ?? 0),
    projectId: r.project_id,
    projectName: r.project_name,
    ownerId: r.owner_id,
    ownerName: r.owner_name,
    isOwner: r.owner_id === access.userId,
    updatedAt: r.updated_at,
  }
}

const PROMPT_SELECT = `
  SELECT p.id, p.title, p.body, p.shared_roles, p.project_id, pr.name AS project_name, p.owner_id,
         u.display_name AS owner_name, p.updated_at,
         (SELECT count(*) FROM share_links l
           WHERE l.resource_type = 'prompt' AND l.resource_id = p.id AND l.revoked_at IS NULL
             AND (l.expires_at IS NULL OR l.expires_at > now())) AS active_links
    FROM prompts p
    JOIN projects pr ON pr.id = p.project_id
    LEFT JOIN users u ON u.id = p.owner_id`

promptsRouter.get(
  '/prompts',
  { permission: 'prompts.read', flag: FLAG },
  asyncHandler(async (req, res) => {
    const access = accessOf(req)
    const { rows } = await pool.query(
      `${PROMPT_SELECT} WHERE ${VISIBLE} ORDER BY p.updated_at DESC, p.id`,
      visibleParams(access),
    )
    res.json({ prompts: rows.map((r) => mapPrompt(r, access)) })
  }),
)

promptsRouter.get(
  '/prompts/:promptId',
  { permission: 'prompts.read', flag: FLAG },
  asyncHandler(async (req, res) => {
    const access = accessOf(req)
    const id = uuidParam(req.params.promptId, 'Prompt')
    const { rows } = await pool.query(`${PROMPT_SELECT} WHERE ${VISIBLE} AND p.id = $5`, [...visibleParams(access), id])
    if (!rows[0]) throw notFound('Prompt')
    const prompt = mapPrompt(rows[0], access)
    // Links are listed for the owner and for admins who manage links, nobody else.
    let links: unknown[] = []
    if (prompt.isOwner || access.permissions.includes('links.manage')) {
      const result = await pool.query(
        `SELECT l.id, l.token_hint, l.expires_at, l.revoked_at, l.last_used_at, l.created_at, u.display_name AS created_by_name
           FROM share_links l LEFT JOIN users u ON u.id = l.created_by
          WHERE l.org_id = $1 AND l.resource_type = 'prompt' AND l.resource_id = $2
          ORDER BY l.created_at DESC`,
        [access.orgId, id],
      )
      links = result.rows.map((l) => ({
        id: l.id,
        tokenHint: l.token_hint,
        expiresAt: l.expires_at,
        revokedAt: l.revoked_at,
        lastUsedAt: l.last_used_at,
        createdAt: l.created_at,
        createdByName: l.created_by_name,
      }))
    }
    res.json({ prompt: { ...prompt, links } })
  }),
)

const sharedRolesSchema = z.array(z.enum(ROLES)).max(ROLES.length)

const createPromptSchema = z
  .object({
    title: z.string().trim().min(1).max(120),
    body: z.string().min(1).max(8000),
    projectId: z.string(),
    sharedRoles: sharedRolesSchema.default([]),
  })
  .strict()

promptsRouter.post(
  '/prompts',
  { permission: 'prompts.write', flag: FLAG },
  asyncHandler(async (req, res) => {
    const access = accessOf(req)
    const body = createPromptSchema.parse(req.body)
    if (!isUuid(body.projectId) || !access.projectIds.includes(body.projectId)) throw notFound('Project')
    if (body.sharedRoles.length > 0 && !access.permissions.includes('prompts.share')) {
      throw new HttpError(403, 'FORBIDDEN', "Your role can't share prompts", { permission: 'prompts.share' })
    }
    const { rows } = await pool.query(
      `INSERT INTO prompts (org_id, project_id, owner_id, title, body, shared_roles)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [access.orgId, body.projectId, access.userId, body.title, body.body, [...new Set(body.sharedRoles)]],
    )
    res.status(201).json({ prompt: { id: rows[0].id } })
  }),
)

const updatePromptSchema = z
  .object({
    title: z.string().trim().min(1).max(120).optional(),
    body: z.string().min(1).max(8000).optional(),
    sharedRoles: sharedRolesSchema.optional(),
  })
  .strict()

promptsRouter.patch(
  '/prompts/:promptId',
  { permission: 'prompts.write', flag: FLAG },
  asyncHandler(async (req, res) => {
    const access = accessOf(req)
    const id = uuidParam(req.params.promptId, 'Prompt')
    const body = updatePromptSchema.parse(req.body)
    if (body.sharedRoles && !access.permissions.includes('prompts.share')) {
      throw new HttpError(403, 'FORBIDDEN', "Your role can't share prompts", { permission: 'prompts.share' })
    }
    const result = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `SELECT p.title, p.body, p.shared_roles, p.owner_id FROM prompts p WHERE ${VISIBLE} AND p.id = $5 FOR UPDATE`,
        [...visibleParams(access), id],
      )
      const before = rows[0]
      if (!before) return null
      if (before.owner_id !== access.userId) {
        throw new HttpError(403, 'NOT_OWNER', 'Only the owner can edit this prompt', { ownerId: before.owner_id })
      }
      const sharedRoles = body.sharedRoles ? [...new Set(body.sharedRoles)] : before.shared_roles
      await client.query(
        `UPDATE prompts SET title = $2, body = $3, shared_roles = $4, updated_at = now() WHERE id = $1 AND org_id = $5`,
        [id, body.title ?? before.title, body.body ?? before.body, sharedRoles, access.orgId],
      )
      if (body.sharedRoles && sharedRoles.join(',') !== before.shared_roles.join(',')) {
        await writeAudit(client, {
          orgId: access.orgId,
          actor: req.user!,
          action: 'prompt.sharing_changed',
          targetType: 'prompt',
          targetId: id,
          targetName: body.title ?? before.title,
          before: { sharedRoles: before.shared_roles },
          after: { sharedRoles },
        })
      }
      return { id, sharedRoles }
    })
    if (!result) throw notFound('Prompt')
    res.json({ prompt: result })
  }),
)

const createLinkSchema = z.object({ expiresInDays: z.number().int().min(1).max(90).nullable().default(30) }).strict()

promptsRouter.post(
  '/prompts/:promptId/links',
  { permission: 'prompts.share', flag: FLAG },
  asyncHandler(async (req, res) => {
    const access = accessOf(req)
    const id = uuidParam(req.params.promptId, 'Prompt')
    const { expiresInDays } = createLinkSchema.parse(req.body ?? {})
    const token = newToken()
    const link = await withTransaction(async (client) => {
      const { rows } = await client.query(`SELECT p.title, p.owner_id FROM prompts p WHERE ${VISIBLE} AND p.id = $5`, [
        ...visibleParams(access),
        id,
      ])
      if (!rows[0]) return null
      if (rows[0].owner_id !== access.userId) {
        throw new HttpError(403, 'NOT_OWNER', 'Only the owner can create links to this prompt')
      }
      const inserted = await client.query(
        `INSERT INTO share_links (org_id, resource_type, resource_id, token_hash, token_hint, created_by, expires_at)
         VALUES ($1, 'prompt', $2, $3, $4, $5, CASE WHEN $6::int IS NULL THEN NULL ELSE now() + make_interval(days => $6::int) END)
         RETURNING id, expires_at, created_at`,
        [access.orgId, id, hashToken(token), token.slice(-4), access.userId, expiresInDays],
      )
      await writeAudit(client, {
        orgId: access.orgId,
        actor: req.user!,
        action: 'link.created',
        targetType: 'prompt',
        targetId: id,
        targetName: rows[0].title,
        after: { linkId: inserted.rows[0].id, expiresAt: inserted.rows[0].expires_at },
      })
      return inserted.rows[0]
    })
    if (!link) throw notFound('Prompt')
    // The raw token is returned exactly once; only its hash is stored.
    res.status(201).json({ link: { id: link.id, token, url: `/share/${token}`, expiresAt: link.expires_at } })
  }),
)
