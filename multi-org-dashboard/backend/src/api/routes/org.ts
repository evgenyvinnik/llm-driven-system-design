/**
 * Org-level endpoints: the permission manifest that drives the whole client,
 * the admin "view as role" preview, the overview page and access requests.
 */
import { z } from 'zod'
import type { EffectiveAccess } from '../../shared/access.js'
import { writeAudit } from '../../shared/audit.js'
import { updateSession } from '../../shared/auth.js'
import { pool } from '../../shared/db.js'
import { asyncHandler, HttpError } from '../../shared/errors.js'
import { accessOf, orgRoutes } from '../../shared/org-access.js'
import { PERMISSIONS, ROLES } from '../../shared/permissions.js'

export const orgRouter = orgRoutes()

/**
 * The one source the client reads for route guards, the sidebar and every
 * action button. It is computed by the same code that enforces access, so
 * the UI and the API cannot disagree about what a role may do.
 */
export function toManifest(access: EffectiveAccess) {
  return {
    org: { id: access.orgId, name: access.orgName, plan: access.plan, branding: access.branding },
    role: access.role,
    actualRole: access.actualRole,
    readOnly: access.readOnly,
    permissions: access.permissions,
    entitlements: access.entitlements,
    flags: access.flags,
    projects: access.projects,
    version: access.version,
  }
}

orgRouter.get(
  '/manifest',
  { permission: 'member' },
  asyncHandler(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    res.json({ manifest: toManifest(accessOf(req)) })
  }),
)

const previewSchema = z.object({ role: z.enum(ROLES).nullable() }).strict()

/** An admin previews the console as another role. Stored on the session; every write is refused while it lasts. */
orgRouter.post(
  '/preview',
  { permission: 'member', allowInPreview: true },
  asyncHandler(async (req, res) => {
    const access = accessOf(req)
    const { role } = previewSchema.parse(req.body)
    if (access.actualRole !== 'admin') {
      throw new HttpError(403, 'FORBIDDEN', 'Only admins can preview other roles', { permission: 'members.manage' })
    }
    const user = { ...req.user! }
    if (role === null || role === 'admin') delete user.preview
    else user.preview = { orgId: access.orgId, role }
    await updateSession(req.sessionId!, user)
    res.json({ preview: user.preview ?? null })
  }),
)

orgRouter.get(
  '/overview',
  { permission: 'org.read' },
  asyncHandler(async (req, res) => {
    const access = accessOf(req)
    const params = [access.orgId, access.projectIds]
    const [counts, recent] = await Promise.all([
      pool.query(
        `SELECT
           (SELECT count(*) FROM agents WHERE org_id = $1 AND project_id = ANY($2::uuid[])) AS agents,
           (SELECT count(*) FROM agents WHERE org_id = $1 AND project_id = ANY($2::uuid[]) AND status = 'live') AS live_agents,
           (SELECT count(*) FROM knowledge_docs WHERE org_id = $1 AND project_id = ANY($2::uuid[])) AS docs,
           (SELECT count(*) FROM conversations WHERE org_id = $1 AND project_id = ANY($2::uuid[])
              AND started_at >= now() - interval '7 days') AS conversations_7d,
           (SELECT count(*) FROM conversations WHERE org_id = $1 AND project_id = ANY($2::uuid[])
              AND status = 'escalated' AND started_at >= now() - interval '7 days') AS escalated_7d`,
        params,
      ),
      pool.query(
        `SELECT c.id, c.subject, c.status, c.started_at, a.name AS agent_name
           FROM conversations c JOIN agents a ON a.id = c.agent_id
          WHERE c.org_id = $1 AND c.project_id = ANY($2::uuid[])
          ORDER BY c.started_at DESC, c.id DESC
          LIMIT 6`,
        params,
      ),
    ])
    const c = counts.rows[0]
    res.json({
      stats: {
        agents: Number(c.agents),
        liveAgents: Number(c.live_agents),
        docs: Number(c.docs),
        conversations7d: Number(c.conversations_7d),
        escalated7d: Number(c.escalated_7d),
      },
      recent: recent.rows.map((r) => ({
        id: r.id,
        subject: r.subject,
        status: r.status,
        startedAt: r.started_at,
        agentName: r.agent_name,
      })),
    })
  }),
)

const accessRequestSchema = z
  .object({
    permission: z.enum(PERMISSIONS).optional(),
    page: z.string().max(200).optional(),
    message: z.string().trim().max(500).optional(),
  })
  .strict()

/** "Request access" on a forbidden page. Recorded in the audit log, which admins read. */
orgRouter.post(
  '/access-requests',
  { permission: 'member' },
  asyncHandler(async (req, res) => {
    const access = accessOf(req)
    const body = accessRequestSchema.parse(req.body)
    await writeAudit(pool, {
      orgId: access.orgId,
      actor: req.user!,
      action: 'access.requested',
      targetType: 'permission',
      targetId: body.permission ?? null,
      targetName: body.page ?? null,
      after: { role: access.role, message: body.message ?? null },
    })
    res.status(202).json({ requested: true })
  }),
)
