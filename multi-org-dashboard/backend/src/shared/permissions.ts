/**
 * The authorization model as pure functions: roles map to permissions, plans
 * map to entitlements, flag rules map to flags. `computeAccess` combines them
 * into the effective access for one user in one org. No I/O here, so every
 * role x plan x flag combination can be tested exhaustively and cheaply.
 * @module shared/permissions
 */

export const ROLES = ['admin', 'editor', 'viewer'] as const
export type Role = (typeof ROLES)[number]

export const PERMISSIONS = [
  'org.read',
  'agents.read',
  'agents.write',
  'agents.delete',
  'knowledge.read',
  'knowledge.write',
  'conversations.read',
  'conversations.export',
  'analytics.read',
  'analytics.cost',
  'prompts.read',
  'prompts.write',
  'prompts.share',
  'billing.read',
  'members.read',
  'members.manage',
  'links.manage',
  'audit.read',
  'features.manage',
] as const
export type Permission = (typeof PERMISSIONS)[number]

const VIEWER: Permission[] = [
  'org.read',
  'agents.read',
  'knowledge.read',
  'conversations.read',
  'analytics.read',
  'prompts.read',
]

const EDITOR: Permission[] = [
  ...VIEWER,
  'agents.write',
  'knowledge.write',
  'conversations.export',
  'prompts.write',
  'prompts.share',
  'members.read',
]

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  viewer: VIEWER,
  editor: EDITOR,
  admin: PERMISSIONS,
}

/**
 * What the org has paid for. Separate from permissions: an admin on the
 * starter plan *may* export (permission) but the org *can't* (entitlement),
 * and the UI says "upgrade" rather than "ask an admin".
 */
export interface Entitlements {
  exports: boolean
  costAnalytics: boolean
  seats: number
  auditRetentionDays: number
}

export const PLANS = ['starter', 'pro'] as const
export type Plan = (typeof PLANS)[number]

export const PLAN_ENTITLEMENTS: Record<Plan, Entitlements> = {
  starter: { exports: false, costAnalytics: false, seats: 10, auditRetentionDays: 30 },
  pro: { exports: true, costAnalytics: true, seats: 100, auditRetentionDays: 365 },
}

export type EntitlementFlag = 'exports' | 'costAnalytics'

export interface FlagDefinition {
  key: string
  defaultEnabled: boolean
}

/** One org's rule for a flag. An empty `roles` list means every role. */
export interface FlagRule {
  flagKey: string
  enabled: boolean
  roles: Role[]
}

export function evaluateFlags(definitions: FlagDefinition[], rules: FlagRule[], role: Role): Record<string, boolean> {
  const flags: Record<string, boolean> = {}
  for (const def of definitions) {
    const rule = rules.find((r) => r.flagKey === def.key)
    flags[def.key] = rule ? rule.enabled && (rule.roles.length === 0 || rule.roles.includes(role)) : def.defaultEnabled
  }
  return flags
}

export interface AccessInput {
  role: Role
  /** Set when an admin previews the console as another role; the preview is read-only. */
  previewRole?: Role
  plan: Plan
  flagDefinitions: FlagDefinition[]
  flagRules: FlagRule[]
}

export interface ComputedAccess {
  role: Role
  actualRole: Role
  readOnly: boolean
  permissions: Permission[]
  entitlements: Entitlements
  flags: Record<string, boolean>
}

export function computeAccess(input: AccessInput): ComputedAccess {
  // A preview stored on the session outlives the admin role that created it, so it only
  // applies while the user is still an admin; otherwise it could widen a demoted user's reads.
  const previewing = input.previewRole !== undefined && input.role === 'admin'
  const role = previewing ? input.previewRole! : input.role
  return {
    role,
    actualRole: input.role,
    readOnly: previewing,
    permissions: [...ROLE_PERMISSIONS[role]],
    entitlements: { ...PLAN_ENTITLEMENTS[input.plan] },
    flags: evaluateFlags(input.flagDefinitions, input.flagRules, role),
  }
}

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value)
}
