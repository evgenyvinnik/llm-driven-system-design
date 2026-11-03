/**
 * The single gate for every route under /api/v1/orgs/:orgId. Routes are
 * declared through `orgRoutes()`, which forces each one to state its access
 * rule and records it in `routeInventory`; a test walks the Express stack and
 * fails if any org route was registered without going through here.
 *
 * Status codes, deliberately distinct:
 *  401 UNAUTHENTICATED       no session: sign in and come back to the same URL
 *  404 NOT_FOUND             not a member of this org (or it doesn't exist): don't reveal which
 *  403 FORBIDDEN             member, but the role lacks the permission
 *  403 FEATURE_DISABLED      the flag is off for this org and role
 *  403 ENTITLEMENT_REQUIRED  the plan doesn't include it (UI offers an upgrade, not "ask an admin")
 *  403 READ_ONLY             an admin previewing as another role tried to write
 * @module shared/org-access
 */
import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express'
import { loadAccess, type EffectiveAccess } from './access.js'
import { asyncHandler, HttpError } from './errors.js'
import { isOrgId } from './ids.js'
import { authzDenials } from './metrics.js'
import type { EntitlementFlag, Permission } from './permissions.js'

declare global {
  namespace Express {
    interface Request {
      access?: EffectiveAccess
    }
  }
}

export interface AccessRule {
  /** 'member' means any role in the org may call it. */
  permission: Permission | 'member'
  flag?: string
  entitlement?: EntitlementFlag
  /** Reads that must not trust the cache (downloads, exports). Writes are always authoritative. */
  authoritative?: boolean
  /** Allowed while previewing as another role (only the preview toggle itself). */
  allowInPreview?: boolean
}

export interface InventoryEntry extends AccessRule {
  method: string
  path: string
}

export const routeInventory: InventoryEntry[] = []

function deny(status: number, code: string, message: string, details?: unknown): HttpError {
  authzDenials.inc({ status: String(status), code })
  return new HttpError(status, code, message, details)
}

export function requireOrg(rule: AccessRule) {
  return asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const orgId = req.params.orgId
    if (!req.user) throw deny(401, 'UNAUTHENTICATED', 'Your session has ended. Sign in to continue.')
    if (!isOrgId(orgId)) throw deny(404, 'NOT_FOUND', 'Organization not found')

    const isWrite = req.method !== 'GET' && req.method !== 'HEAD'
    const preview = req.user.preview?.orgId === orgId ? req.user.preview.role : undefined
    const access = await loadAccess(req.user.id, orgId, {
      authoritative: isWrite || rule.authoritative === true,
      previewRole: preview,
    })
    if (!access) throw deny(404, 'NOT_FOUND', 'Organization not found')

    // Every org-scoped response says which org and which authz version produced it.
    // The client refetches its manifest when it sees a newer version, even with no event stream.
    res.setHeader('X-Org-Id', access.orgId)
    res.setHeader('X-Authz-Version', String(access.version))
    // Tenant data must never be served from a shared or browser cache to the next person at this desk.
    res.setHeader('Cache-Control', 'private, no-store')

    const details = { role: access.role, version: access.version }
    if (isWrite && access.readOnly && !rule.allowInPreview) {
      throw deny(403, 'READ_ONLY', `You're previewing this organization as ${access.role}. Changes are turned off.`, details)
    }
    if (rule.permission !== 'member' && !access.permissions.includes(rule.permission)) {
      throw deny(403, 'FORBIDDEN', `Your role (${access.role}) doesn't include this.`, {
        ...details,
        permission: rule.permission,
      })
    }
    if (rule.flag && !access.flags[rule.flag]) {
      throw deny(403, 'FEATURE_DISABLED', 'This feature is not turned on for your organization and role.', {
        ...details,
        flag: rule.flag,
      })
    }
    if (rule.entitlement && !access.entitlements[rule.entitlement]) {
      throw deny(403, 'ENTITLEMENT_REQUIRED', `The ${access.plan} plan doesn't include this.`, {
        ...details,
        entitlement: rule.entitlement,
        plan: access.plan,
      })
    }
    req.access = access
    next()
  })
}

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete'

/** A router mounted at /api/v1/orgs/:orgId whose every route must declare an AccessRule. */
export function orgRoutes() {
  const router = Router({ mergeParams: true })
  const register =
    (method: Method) =>
    (path: string, rule: AccessRule, ...handlers: RequestHandler[]) => {
      routeInventory.push({ method: method.toUpperCase(), path: `/api/v1/orgs/:orgId${path}`, ...rule })
      router[method](path, requireOrg(rule), ...handlers)
    }
  return {
    router,
    get: register('get'),
    post: register('post'),
    put: register('put'),
    patch: register('patch'),
    delete: register('delete'),
  }
}

/** For handlers: the access attached by requireOrg. */
export function accessOf(req: Request): EffectiveAccess {
  if (!req.access) throw new Error('requireOrg did not run for this route')
  return req.access
}
