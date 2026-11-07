/**
 * Org policy (org_admin and above) and the global catalog (platform_admin).
 *
 *   GET    /api/v1/admin/org                         policy for the admin's own org
 *   PUT    /api/v1/admin/org/policy/:key             {value, enforced}; If-Match = org revision
 *   DELETE /api/v1/admin/org/policy/:key             clear the policy; If-Match
 *   GET    /api/v1/admin/org/history                 policy and catalog change log
 *   POST   /api/v1/admin/definitions                 add a definition at runtime
 *   POST   /api/v1/admin/definitions/:key/deprecate  {graceDays, replacedBy}
 *
 * The org always comes from the session, so an admin can't address another org.
 * @module api/routes/admin
 */
import { Router } from 'express'
import { z } from 'zod'
import { requireRole } from '../../shared/auth.js'
import { asyncHandler } from '../../shared/errors.js'
import { newDefinitionSchema } from '../../domain/validate.js'
import { createDefinition, deprecateDefinition } from '../../services/catalog-service.js'
import { getOrgHistory, getOrgPolicy, setOrgPolicy } from '../../services/policy-service.js'
import { etag, requireIfMatch } from '../http.js'

export const adminRouter = Router()

const policySchema = z.object({ value: z.union([z.boolean(), z.number(), z.string()]), enforced: z.boolean() }).strict()
const deprecateSchema = z
  .object({ graceDays: z.number().int().min(0).max(365).optional(), replacedBy: z.string().min(1).max(80).nullable().optional() })
  .strict()

adminRouter.get(
  '/org',
  requireRole('org_admin'),
  asyncHandler(async (req, res) => {
    const policy = await getOrgPolicy(req.user!)
    res.set({ ETag: etag(policy.orgRevision), 'Cache-Control': 'no-store' })
    res.json(policy)
  }),
)

adminRouter.put(
  '/org/policy/:key',
  requireRole('org_admin'),
  asyncHandler(async (req, res) => {
    const body = policySchema.parse(req.body)
    const base = requireIfMatch(req)
    const result = await setOrgPolicy(req.user!, req.params.key, base, body)
    res.set('ETag', etag(result.orgRevision)).json(result)
  }),
)

adminRouter.delete(
  '/org/policy/:key',
  requireRole('org_admin'),
  asyncHandler(async (req, res) => {
    const base = requireIfMatch(req)
    const result = await setOrgPolicy(req.user!, req.params.key, base, null)
    res.set('ETag', etag(result.orgRevision)).json(result)
  }),
)

adminRouter.get(
  '/org/history',
  requireRole('org_admin'),
  asyncHandler(async (req, res) => {
    res.json({ changes: await getOrgHistory(req.user!) })
  }),
)

adminRouter.post(
  '/definitions',
  requireRole('platform_admin'),
  asyncHandler(async (req, res) => {
    const input = newDefinitionSchema.parse(req.body)
    res.status(201).json({ definition: await createDefinition(req.user!, input) })
  }),
)

adminRouter.post(
  '/definitions/:key/deprecate',
  requireRole('platform_admin'),
  asyncHandler(async (req, res) => {
    const body = deprecateSchema.parse(req.body ?? {})
    res.json({ definition: await deprecateDefinition(req.user!, req.params.key, body) })
  }),
)
