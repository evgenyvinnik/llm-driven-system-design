/**
 * Event publishing over Valkey pub/sub. Events are invalidation hints, never
 * data: a client that misses one still converges, because every org-scoped
 * response carries the org's authz version and the stream's `hello` frame
 * repeats the versions on reconnect.
 * @module shared/events
 */
import { redis } from './cache.js'
import { logger } from './logger.js'
import type { Role } from './permissions.js'

export type AuthzChangeReason =
  | 'role_changed'
  | 'member_removed'
  | 'member_added'
  | 'flag_changed'
  | 'project_access_changed'

/** Fan-out to every connected member of an org. */
export type OrgEvent = { type: 'authz.changed'; orgId: string; version: number; reason: AuthzChangeReason }

/** Delivered to one user's connections only. */
export type UserEvent =
  | { type: 'access.revoked'; orgId: string; orgName: string; reason: 'removed' }
  | { type: 'membership.added'; orgId: string; orgName: string; role: Role }
  | { type: 'role.changed'; orgId: string; orgName: string; from: Role; to: Role }
  | { type: 'export.progress'; orgId: string; exportId: string; processedRows: number; totalRows: number }
  | { type: 'export.completed'; orgId: string; exportId: string; totalRows: number }
  | { type: 'export.failed'; orgId: string; exportId: string; error: string }
  | { type: 'session.revoked'; reason: 'no_memberships' | 'signed_out' }

export const orgChannel = (orgId: string) => `evt:org:${orgId}`
export const userChannel = (userId: string) => `evt:user:${userId}`

async function publish(channel: string, event: unknown): Promise<void> {
  try {
    await redis.publish(channel, JSON.stringify(event))
  } catch (err) {
    // A lost hint is tolerable (see module comment); a failed request is not.
    logger.warn({ err: (err as Error).message, channel }, 'event publish failed')
  }
}

export const publishOrgEvent = (event: OrgEvent) => publish(orgChannel(event.orgId), event)
export const publishUserEvent = (userId: string, event: UserEvent) => publish(userChannel(userId), event)
