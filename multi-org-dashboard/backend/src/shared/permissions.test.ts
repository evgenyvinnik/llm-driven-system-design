import { describe, expect, it } from 'vitest'
import {
  computeAccess,
  evaluateFlags,
  PERMISSIONS,
  PLAN_ENTITLEMENTS,
  PLANS,
  ROLE_PERMISSIONS,
  ROLES,
  type FlagRule,
  type Role,
} from './permissions.js'

const FLAG = [{ key: 'prompt_library', defaultEnabled: false }]

/**
 * The model is a pure function, so every combination is cheap to test. What
 * gets tested combinatorially is the *rules*; end-to-end tests then only need
 * one persona per rule, not one per permutation.
 */
const RULE_SHAPES: Array<{ name: string; rules: FlagRule[]; on: Role[] }> = [
  { name: 'no rule', rules: [], on: [] },
  { name: 'off', rules: [{ flagKey: 'prompt_library', enabled: false, roles: [] }], on: [] },
  { name: 'on for everyone', rules: [{ flagKey: 'prompt_library', enabled: true, roles: [] }], on: ['admin', 'editor', 'viewer'] },
  { name: 'on for admin+editor', rules: [{ flagKey: 'prompt_library', enabled: true, roles: ['admin', 'editor'] }], on: ['admin', 'editor'] },
  { name: 'disabled but roles listed', rules: [{ flagKey: 'prompt_library', enabled: false, roles: ['viewer'] }], on: [] },
]

describe('role permissions', () => {
  it('nests: every viewer permission is an editor permission, every editor permission is an admin permission', () => {
    for (const p of ROLE_PERMISSIONS.viewer) expect(ROLE_PERMISSIONS.editor).toContain(p)
    for (const p of ROLE_PERMISSIONS.editor) expect(ROLE_PERMISSIONS.admin).toContain(p)
  })

  it('gives admins every permission and keeps management away from editors and viewers', () => {
    expect([...ROLE_PERMISSIONS.admin].sort()).toEqual([...PERMISSIONS].sort())
    for (const role of ['editor', 'viewer'] as const) {
      for (const p of ['members.manage', 'billing.read', 'audit.read', 'features.manage', 'links.manage'] as const) {
        expect(ROLE_PERMISSIONS[role]).not.toContain(p)
      }
    }
  })
})

describe('computeAccess over every role x plan x flag rule', () => {
  for (const role of ROLES) {
    for (const plan of PLANS) {
      for (const shape of RULE_SHAPES) {
        it(`${role} / ${plan} / ${shape.name}`, () => {
          const access = computeAccess({ role, plan, flagDefinitions: FLAG, flagRules: shape.rules })
          expect(access.permissions).toEqual([...ROLE_PERMISSIONS[role]])
          expect(access.entitlements).toEqual(PLAN_ENTITLEMENTS[plan])
          expect(access.flags.prompt_library).toBe(shape.on.includes(role))
          expect(access.readOnly).toBe(false)
          // Entitlements never grant permissions, and permissions never grant entitlements.
          expect(access.permissions.includes('conversations.export')).toBe(role !== 'viewer')
          expect(access.entitlements.exports).toBe(plan === 'pro')
        })
      }
    }
  }
})

describe('preview (view as role)', () => {
  it('narrows to the previewed role, is read-only, and keeps the real role', () => {
    const access = computeAccess({ role: 'admin', previewRole: 'viewer', plan: 'pro', flagDefinitions: FLAG, flagRules: RULE_SHAPES[3].rules })
    expect(access.role).toBe('viewer')
    expect(access.actualRole).toBe('admin')
    expect(access.readOnly).toBe(true)
    expect(access.permissions).not.toContain('members.manage')
    expect(access.flags.prompt_library).toBe(false)
  })
})

describe('evaluateFlags', () => {
  it('falls back to the default when the org has no rule', () => {
    expect(evaluateFlags([{ key: 'beta', defaultEnabled: true }], [], 'viewer')).toEqual({ beta: true })
  })
})
