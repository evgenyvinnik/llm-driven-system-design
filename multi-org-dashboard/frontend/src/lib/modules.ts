/**
 * The module registry: one list that the sidebar, the route guards and the
 * settings tabs all read, evaluated against the server's manifest. Nothing
 * else in the client decides what a role may see.
 *
 * The decision distinguishes *why* something is unavailable, because the UI
 * answers differently: a missing permission says "ask an admin", a missing
 * entitlement says "upgrade", a flag that is off hides the module entirely.
 */
import type { EntitlementFlag, Manifest, Permission } from '@/types'

export interface Requirement {
  permission: Permission
  flag?: string
  entitlement?: EntitlementFlag
}

export type ModuleKey =
  | 'overview'
  | 'agents'
  | 'knowledge'
  | 'conversations'
  | 'analytics'
  | 'prompts'
  | 'exports'
  | 'billing'
  | 'settings'

/** Router paths for each module, as literals so links stay type-checked. */
export const MODULE_ROUTES = {
  overview: '/orgs/$orgId',
  agents: '/orgs/$orgId/agents',
  knowledge: '/orgs/$orgId/knowledge',
  conversations: '/orgs/$orgId/conversations',
  analytics: '/orgs/$orgId/analytics',
  prompts: '/orgs/$orgId/prompts',
  exports: '/orgs/$orgId/exports',
  billing: '/orgs/$orgId/billing',
  settings: '/orgs/$orgId/settings',
} as const satisfies Record<ModuleKey, string>

export interface ModuleDef {
  key: ModuleKey
  label: string
  /** Path segment under /orgs/$orgId. */
  path: string
  requires: Requirement
  badge?: string
}

export const MODULES: ModuleDef[] = [
  { key: 'overview', label: 'Overview', path: '', requires: { permission: 'org.read' } },
  { key: 'agents', label: 'Agents', path: 'agents', requires: { permission: 'agents.read' } },
  { key: 'knowledge', label: 'Knowledge base', path: 'knowledge', requires: { permission: 'knowledge.read' } },
  { key: 'conversations', label: 'Conversations', path: 'conversations', requires: { permission: 'conversations.read' } },
  { key: 'analytics', label: 'Analytics', path: 'analytics', requires: { permission: 'analytics.read' } },
  {
    key: 'prompts',
    label: 'Prompt library',
    path: 'prompts',
    requires: { permission: 'prompts.read', flag: 'prompt_library' },
    badge: 'Beta',
  },
  {
    key: 'exports',
    label: 'Exports',
    path: 'exports',
    requires: { permission: 'conversations.export', entitlement: 'exports' },
  },
  { key: 'billing', label: 'Billing', path: 'billing', requires: { permission: 'billing.read' } },
  { key: 'settings', label: 'Settings', path: 'settings', requires: { permission: 'members.read' } },
]

export type SettingsTab = 'members' | 'invitations' | 'links' | 'audit' | 'features'

export const SETTINGS_TABS: Array<{ key: SettingsTab; label: string; requires: Requirement }> = [
  { key: 'members', label: 'Members', requires: { permission: 'members.read' } },
  { key: 'invitations', label: 'Invitations', requires: { permission: 'members.manage' } },
  { key: 'links', label: 'Share links', requires: { permission: 'links.manage' } },
  { key: 'audit', label: 'Audit log', requires: { permission: 'audit.read' } },
  { key: 'features', label: 'Features', requires: { permission: 'features.manage' } },
]

export type Decision =
  | { allowed: true }
  | { allowed: false; reason: 'permission'; permission: Permission }
  | { allowed: false; reason: 'flag'; flag: string }
  | { allowed: false; reason: 'entitlement'; entitlement: EntitlementFlag }

/** Order matters: a role without the permission is told about the role, not about the plan. */
export function decide(manifest: Manifest, req: Requirement): Decision {
  if (!manifest.permissions.includes(req.permission)) return { allowed: false, reason: 'permission', permission: req.permission }
  if (req.flag && !manifest.flags[req.flag]) return { allowed: false, reason: 'flag', flag: req.flag }
  if (req.entitlement && !manifest.entitlements[req.entitlement]) {
    return { allowed: false, reason: 'entitlement', entitlement: req.entitlement }
  }
  return { allowed: true }
}

export function moduleByKey(key: ModuleKey): ModuleDef {
  return MODULES.find((m) => m.key === key)!
}

/** The module a pathname belongs to (/orgs/<id>/<segment>/...), defaulting to the overview. */
export function moduleFromPath(pathname: string): ModuleKey {
  const segment = pathname.split('/')[3] ?? ''
  return MODULES.find((m) => m.path === segment)?.key ?? 'overview'
}

/**
 * Sidebar entries: allowed modules, plus modules locked only by the plan
 * (shown with a lock so the upgrade is discoverable). Permission- and
 * flag-denied modules are not shown at all.
 */
export function sidebarModules(manifest: Manifest): Array<ModuleDef & { locked: boolean }> {
  return MODULES.flatMap((m): Array<ModuleDef & { locked: boolean }> => {
    const d = decide(manifest, m.requires)
    if (d.allowed) return [{ ...m, locked: false }]
    if (d.reason === 'entitlement') return [{ ...m, locked: true }]
    return []
  })
}

export function can(manifest: Manifest, permission: Permission): boolean {
  return manifest.permissions.includes(permission)
}

/** Modules allowed in `before` but not in `after`: what the user just lost. */
export function lostModules(before: Manifest, after: Manifest): ModuleKey[] {
  return MODULES.filter((m) => decide(before, m.requires).allowed && !decide(after, m.requires).allowed).map((m) => m.key)
}
