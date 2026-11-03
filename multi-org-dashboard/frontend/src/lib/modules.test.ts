import { describe, expect, it } from 'vitest'
import type { Manifest, Permission, Role } from '@/types'
import { decide, lostModules, MODULES, sidebarModules } from './modules'

// Mirrors the server's role table (backend/src/shared/permissions.ts); the server stays authoritative.
const VIEWER: Permission[] = ['org.read', 'agents.read', 'knowledge.read', 'conversations.read', 'analytics.read', 'prompts.read']
const EDITOR: Permission[] = [...VIEWER, 'agents.write', 'knowledge.write', 'conversations.export', 'prompts.write', 'prompts.share', 'members.read']
const ADMIN: Permission[] = [...EDITOR, 'agents.delete', 'analytics.cost', 'billing.read', 'members.manage', 'links.manage', 'audit.read', 'features.manage']
const BY_ROLE: Record<Role, Permission[]> = { viewer: VIEWER, editor: EDITOR, admin: ADMIN }

function manifest(role: Role, plan: 'starter' | 'pro', flag: boolean, version = 1): Manifest {
  return {
    org: { id: 'org_test', name: 'Test', plan, branding: { accent: 'teal', initials: 'TE' } },
    role,
    actualRole: role,
    readOnly: false,
    permissions: BY_ROLE[role],
    entitlements: { exports: plan === 'pro', costAnalytics: plan === 'pro', seats: 10, auditRetentionDays: 30 },
    flags: { prompt_library: flag },
    projects: [],
    version,
  }
}

/**
 * The guard logic is one pure function over the manifest, so all 12
 * role x plan x flag combinations are checked here in milliseconds. Browser
 * tests then need one persona per *rule* (hidden, locked, allowed), not one
 * per combination.
 */
describe('module decisions over every role x plan x flag', () => {
  for (const role of ['admin', 'editor', 'viewer'] as Role[]) {
    for (const plan of ['starter', 'pro'] as const) {
      for (const flag of [true, false]) {
        it(`${role} / ${plan} / prompt_library ${flag ? 'on' : 'off'}`, () => {
          const m = manifest(role, plan, flag)
          const visible = sidebarModules(m)
          const keys = visible.map((v) => v.key)
          expect(keys).toContain('overview')
          expect(keys.includes('prompts')).toBe(flag)
          expect(keys.includes('billing')).toBe(role === 'admin')
          expect(keys.includes('settings')).toBe(role !== 'viewer')
          // Exports: hidden for viewers (role), shown locked on starter (plan), open on pro.
          const exportsEntry = visible.find((v) => v.key === 'exports')
          if (role === 'viewer') expect(exportsEntry).toBeUndefined()
          else expect(exportsEntry?.locked).toBe(plan === 'starter')
          // Every visible, unlocked module is one the guard lets through, and vice versa.
          for (const mod of MODULES) {
            const allowed = decide(m, mod.requires).allowed
            expect(allowed).toBe(visible.some((v) => v.key === mod.key && !v.locked))
          }
        })
      }
    }
  }
})

describe('decide', () => {
  it('reports the role before the plan', () => {
    const d = decide(manifest('viewer', 'starter', false), { permission: 'conversations.export', entitlement: 'exports' })
    expect(d).toEqual({ allowed: false, reason: 'permission', permission: 'conversations.export' })
  })
})

describe('lostModules', () => {
  it('lists what a demotion takes away', () => {
    expect(lostModules(manifest('admin', 'pro', true), manifest('viewer', 'pro', true, 2))).toEqual(['exports', 'billing', 'settings'])
  })
  it('includes a module whose flag was turned off', () => {
    expect(lostModules(manifest('editor', 'pro', true), manifest('editor', 'pro', false, 2))).toEqual(['prompts'])
  })
})
