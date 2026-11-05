import { describe, expect, it } from 'vitest'
import { evaluateBakeSignal } from './bake.js'
import { CONTROLS, evaluateAccount, getControl } from './controls.js'
import { classifyEvidence, evidenceWindow, summarizeUsage, trafficPerMinute } from './evidence.js'
import { canDecide, findExpired, isExceptionActive, isExpiringSoon, validateExceptionRequest } from './exceptions.js'
import { planFindings } from './findings.js'
import { riskScore } from './risk.js'
import type { AccountSnapshot, UsageCaller, UsageSummary } from './types.js'

const NOW = Date.parse('2026-11-05T12:00:00Z')
const DAY = 86_400_000

function account(overrides: Partial<AccountSnapshot['properties']> = {}, extra: Partial<AccountSnapshot> = {}): AccountSnapshot {
  return {
    id: '/subscriptions/s1/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/stdemo',
    subscriptionId: 's1',
    resourceGroup: 'rg',
    name: 'stdemo',
    location: 'eastus',
    tags: { env: 'prod', dataClassification: 'confidential', owner: 'payments' },
    properties: {
      allowBlobPublicAccess: false,
      allowSharedKeyAccess: false,
      minimumTlsVersion: 'TLS1_2',
      supportsHttpsTrafficOnly: true,
      publicNetworkAccess: 'Disabled',
      networkAcls: { defaultAction: 'Deny', bypass: 'AzureServices', ipRules: [] },
      ...overrides,
    },
    blobService: { deleteRetentionPolicy: { enabled: true, days: 7 } },
    diagnostics: { enabled: true, workspaceId: '/subscriptions/sec-logging/resourceGroups/rg-logging/providers/Microsoft.OperationalInsights/workspaces/law-storage-central', categories: [], createdAt: new Date(NOW - 200 * DAY).toISOString() },
    ...extra,
  }
}

const caller = (c: Partial<UsageCaller>): UsageCaller => ({ callerIp: '10.0.0.4', userAgent: 'sdk', authType: 'OAuth', tlsVersion: 'TLS 1.2', protocol: 'HTTPS', requests: 100, lastSeen: new Date(NOW).toISOString(), ...c })
const usage = (callers: UsageCaller[], windowDays = 30, hasLogs = true): UsageSummary => summarizeUsage(callers, { hasLogs, windowDays })

describe('control evaluation', () => {
  it('passes a fully hardened account on every control', () => {
    expect(evaluateAccount(account()).every((r) => r.compliant === true)).toBe(true)
  })

  it('flags each insecure setting against its own control', () => {
    const results = evaluateAccount(account({ allowBlobPublicAccess: true, allowSharedKeyAccess: true, minimumTlsVersion: 'TLS1_0', supportsHttpsTrafficOnly: false, publicNetworkAccess: 'Enabled', networkAcls: { defaultAction: 'Allow', bypass: 'AzureServices', ipRules: [] } }))
    expect(results.filter((r) => r.compliant === false).map((r) => r.controlId)).toEqual(['SA-01', 'SA-02', 'SA-03', 'SA-04', 'SA-05'])
  })

  it('treats network access as compliant when either public access is off or the firewall denies by default', () => {
    const net = getControl('SA-05')
    expect(net.isCompliant({ publicNetworkAccess: 'Enabled', defaultAction: 'Deny' })).toBe(true)
    expect(net.isCompliant({ publicNetworkAccess: 'Disabled', defaultAction: 'Allow' })).toBe(true)
    expect(net.isCompliant({ publicNetworkAccess: 'Enabled', defaultAction: 'Allow' })).toBe(false)
  })

  it('requires at least 7 days of soft delete and the central workspace for diagnostics', () => {
    const results = evaluateAccount(account({}, { blobService: { deleteRetentionPolicy: { enabled: true, days: 3 } }, diagnostics: { enabled: true, workspaceId: '/other', categories: [], createdAt: null } }))
    expect(results.find((r) => r.controlId === 'SA-06')?.compliant).toBe(false)
    expect(results.find((r) => r.controlId === 'SA-07')?.compliant).toBe(false)
  })

  it('returns unknown (no finding either way) for child resources not read yet', () => {
    const results = evaluateAccount(account({}, { blobService: null, diagnostics: null }))
    expect(results.find((r) => r.controlId === 'SA-06')?.compliant).toBeNull()
    expect(results.find((r) => r.controlId === 'SA-07')?.compliant).toBeNull()
  })

  it('escalates public access on confidential data to critical', () => {
    expect(evaluateAccount(account({ allowBlobPublicAccess: true })).find((r) => r.controlId === 'SA-01')?.severity).toBe('critical')
    expect(evaluateAccount(account({ allowBlobPublicAccess: true }, { tags: { dataClassification: 'public' } })).find((r) => r.controlId === 'SA-01')?.severity).toBe('high')
  })

  it('builds desired and restore bodies that round-trip the value', () => {
    for (const c of CONTROLS) {
      const restored = c.restore(c.read(c.kind === 'account' ? account({ allowBlobPublicAccess: true }).properties : c.kind === 'blobService' ? { deleteRetentionPolicy: { enabled: false } } : { enabled: false, workspaceId: null, categories: [], createdAt: null }))
      expect(restored).toHaveProperty('properties')
      expect(c.desired(null)).toHaveProperty('properties')
    }
  })
})

describe('evidence classification', () => {
  const sharedKey = getControl('SA-02')

  it('never treats missing logs as proof of non-use', () => {
    expect(classifyEvidence(sharedKey, null, 14).evidenceClass).toBe('insufficient_evidence')
    expect(classifyEvidence(sharedKey, usage([], 0, false), 14).evidenceClass).toBe('insufficient_evidence')
  })

  it('needs a full window: a clean but short log history is insufficient', () => {
    expect(classifyEvidence(sharedKey, usage([caller({})], 5), 14).evidenceClass).toBe('insufficient_evidence')
    expect(classifyEvidence(sharedKey, usage([caller({})], 30), 14).evidenceClass).toBe('safe_to_fix')
  })

  it('counts account key and SAS requests as shared key dependencies, and names the callers', () => {
    const decision = classifyEvidence(sharedKey, usage([caller({}), caller({ authType: 'SAS', requests: 40, callerIp: '52.1.2.3' }), caller({ authType: 'AccountKey', requests: 7 })]), 14)
    expect(decision.evidenceClass).toBe('needs_owner_migration')
    expect(decision.dependentRequests).toBe(47)
    expect(decision.topCallers.map((c) => c.authType)).toEqual(['SAS', 'AccountKey'])
  })

  it('finds a dependency even in a short window (one caller is enough to block)', () => {
    expect(classifyEvidence(sharedKey, usage([caller({ authType: 'AccountKey' })], 3), 14).evidenceClass).toBe('needs_owner_migration')
  })

  it('maps each breaking control to its own signal', () => {
    const u = usage([caller({ authType: 'Anonymous' }), caller({ tlsVersion: 'TLS 1.0' }), caller({ protocol: 'HTTP' }), caller({ callerIp: '20.1.1.1' })])
    expect(u.counts).toMatchObject({ anonymous: 100, legacyTls: 100, http: 100, publicNetwork: 100, total: 400 })
    for (const id of ['SA-01', 'SA-03', 'SA-04', 'SA-05']) expect(classifyEvidence(getControl(id), u, 14).dependentRequests).toBe(100)
  })

  it('always allows additive controls', () => {
    expect(classifyEvidence(getControl('SA-06'), null, 14).evidenceClass).toBe('safe_to_fix')
    expect(classifyEvidence(getControl('SA-07'), null, 14).evidenceClass).toBe('safe_to_fix')
  })

  it('bounds the window by when logging started', () => {
    expect(evidenceWindow({ enabled: true, createdAt: new Date(NOW - 9.5 * DAY).toISOString() }, 30, NOW)).toEqual({ hasLogs: true, windowDays: 9 })
    expect(evidenceWindow({ enabled: true, createdAt: new Date(NOW - 400 * DAY).toISOString() }, 30, NOW)).toEqual({ hasLogs: true, windowDays: 30 })
    expect(evidenceWindow({ enabled: false, createdAt: null }, 30, NOW)).toEqual({ hasLogs: false, windowDays: 0 })
  })

  it('derives requests per minute for wave ordering', () => {
    expect(trafficPerMinute(usage([caller({ requests: 43_200 })], 30))).toBe(1)
    expect(trafficPerMinute(usage([], 0, false))).toBe(0)
  })
})

describe('risk and findings', () => {
  it('ranks an internet-exposed, sensitive, actively used path above a private, unused one', () => {
    const exposed = account({ publicNetworkAccess: 'Enabled', networkAcls: { defaultAction: 'Allow', bypass: 'AzureServices', ipRules: [] } }, { tags: { dataClassification: 'restricted' } })
    const hidden = account({}, { tags: { dataClassification: 'public' } })
    expect(riskScore('high', exposed, 'needs_owner_migration')).toBe(75)
    expect(riskScore('high', hidden, 'safe_to_fix')).toBe(2)
  })

  it('opens, exempts, resolves and detects regressions', () => {
    const snapshot = account({ allowSharedKeyAccess: true, allowBlobPublicAccess: true })
    const results = evaluateAccount(snapshot)
    const existing = new Map([
      ['SA-01', { id: 1, controlId: 'SA-01', status: 'resolved' as const, firstSeenAt: new Date(NOW - 50 * DAY) }],
      ['SA-03', { id: 3, controlId: 'SA-03', status: 'open' as const, firstSeenAt: new Date(NOW - 10 * DAY) }],
    ])
    const plan = planFindings(snapshot, results, existing, usage([caller({ authType: 'AccountKey' })]), new Set(['SA-02']), new Date(NOW), 14)
    expect(plan.resolveIds).toEqual([3])
    const sa01 = plan.writes.find((w) => w.controlId === 'SA-01')!
    const sa02 = plan.writes.find((w) => w.controlId === 'SA-02')!
    expect(sa01).toMatchObject({ status: 'open', reopened: true, severity: 'critical', evidenceClass: 'safe_to_fix' })
    expect(sa01.dueAt.getTime()).toBe(NOW + 7 * DAY)
    expect(sa02).toMatchObject({ status: 'exempt', isNew: true, evidenceClass: 'needs_owner_migration' })
  })
})

describe('bake signal (rollback trigger)', () => {
  const t = { minErrors: 5, baselineMultiplier: 3, minErrorRate: 0.02 }

  it('rolls back on a burst of new authorization failures', () => {
    const d = evaluateBakeSignal({ requests: 600, authErrors: 0, minutes: 1 }, { requests: 40, authErrors: 30, minutes: 0.5 }, t)
    expect(d.rollback).toBe(true)
    expect(d.reason).toMatch(/30 authorization failures/)
  })

  it('ignores a handful of stray failures', () => {
    expect(evaluateBakeSignal({ requests: 600, authErrors: 0, minutes: 1 }, { requests: 600, authErrors: 3, minutes: 1 }, t).rollback).toBe(false)
  })

  it('ignores failures that were already there before the change', () => {
    expect(evaluateBakeSignal({ requests: 1000, authErrors: 20, minutes: 1 }, { requests: 1000, authErrors: 25, minutes: 1 }, t).rollback).toBe(false)
  })

  it('ignores failures that are a tiny share of a busy account', () => {
    expect(evaluateBakeSignal({ requests: 100_000, authErrors: 0, minutes: 1 }, { requests: 100_000, authErrors: 50, minutes: 1 }, t).rollback).toBe(false)
  })
})

describe('exceptions', () => {
  const now = new Date(NOW)
  const at = (offsetMs: number) => new Date(NOW + offsetMs)

  it('is active only while approved and unexpired', () => {
    expect(isExceptionActive({ status: 'approved', expiresAt: at(DAY) }, now)).toBe(true)
    expect(isExceptionActive({ status: 'approved', expiresAt: at(-1) }, now)).toBe(false)
    expect(isExceptionActive({ status: 'pending', expiresAt: at(DAY) }, now)).toBe(false)
  })

  it('finds approved exceptions due to expire, including exactly at expiry', () => {
    const list = [
      { id: 'a', status: 'approved' as const, expiresAt: at(-DAY) },
      { id: 'b', status: 'approved' as const, expiresAt: at(0) },
      { id: 'c', status: 'approved' as const, expiresAt: at(DAY) },
      { id: 'd', status: 'expired' as const, expiresAt: at(-DAY) },
    ]
    expect(findExpired(list, now).map((e) => e.id)).toEqual(['a', 'b'])
  })

  it('warns within the window before expiry', () => {
    expect(isExpiringSoon({ status: 'approved', expiresAt: at(3 * DAY) }, now, 7 * DAY)).toBe(true)
    expect(isExpiringSoon({ status: 'approved', expiresAt: at(10 * DAY) }, now, 7 * DAY)).toBe(false)
  })

  it('caps duration by severity and forbids self-approval', () => {
    expect(validateExceptionRequest('critical', 45)).toMatch(/at most 30/)
    expect(validateExceptionRequest('medium', 180)).toBeNull()
    expect(canDecide('u_bob', 'approver', { status: 'pending', requestedBy: 'u_bob' })).toMatch(/own request/)
    expect(canDecide('u_carol', 'owner', { status: 'pending', requestedBy: 'u_bob' })).toMatch(/Only approvers/)
    expect(canDecide('u_carol', 'approver', { status: 'approved', requestedBy: 'u_bob' })).toMatch(/already approved/)
    expect(canDecide('u_carol', 'approver', { status: 'pending', requestedBy: 'u_bob' })).toBeNull()
  })
})
