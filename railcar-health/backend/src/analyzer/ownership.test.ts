import { describe, expect, it } from 'vitest'
import { TIER } from '../shared/domain.js'
import { ackDeadline, decideEscalation, escalationLabel, needsHandoff, ownerFor } from './ownership.js'

const MIN = 60_000

describe('ownership', () => {
  it('gives train-handling alerts to the dispatcher desk and car-inspection alerts to the yard', () => {
    expect(ownerFor('dispatcher_and_yard', 'WEST', 'CDJ', 'NRLX')).toEqual({ role: 'dispatcher', id: 'WEST' })
    expect(ownerFor('yard_post_arrival', null, 'CDJ', 'SVTX')).toEqual({ role: 'yard', id: 'CDJ' })
    expect(ownerFor('owner_only', 'WEST', 'CDJ', 'TCLX')).toEqual({ role: 'owner', id: 'TCLX' })
  })

  it('sets tighter acknowledgment deadlines for higher tiers, and none for LOW or owner notices', () => {
    expect(ackDeadline(TIER.CRITICAL, 'dispatcher', 0)?.getTime()).toBe(5 * MIN)
    expect(ackDeadline(TIER.HIGH, 'dispatcher', 0)?.getTime()).toBe(15 * MIN)
    expect(ackDeadline(TIER.MEDIUM, 'yard', 0)?.getTime()).toBe(60 * MIN)
    expect(ackDeadline(TIER.LOW, 'owner', 0)).toBeNull()
  })

  it('hands off only when the right owner changed', () => {
    expect(needsHandoff({ role: 'dispatcher', id: 'WEST' }, { role: 'dispatcher', id: 'EAST' })).toBe(true)
    expect(needsHandoff({ role: 'dispatcher', id: 'WEST' }, { role: 'dispatcher', id: 'WEST' })).toBe(false)
    expect(needsHandoff({ role: 'yard', id: 'CDJ' }, { role: 'yard', id: null })).toBe(false)
  })
})

describe('escalation when nobody acknowledges', () => {
  const base = { status: 'open', role: 'dispatcher' as const, level: 0, ackDueAtMs: 15 * MIN, yardEtaMs: null, approachWindowMinutes: 30, alreadyWarnedYard: false }

  it('waits until the deadline, then escalates one level at a time up the chain', () => {
    expect(decideEscalation({ ...base, nowMs: 14 * MIN })).toEqual({ escalate: false })
    expect(decideEscalation({ ...base, nowMs: 16 * MIN })).toEqual({ escalate: true, reason: 'ack_overdue', toLevel: 1 })
    expect(decideEscalation({ ...base, level: 1, nowMs: 16 * MIN })).toMatchObject({ toLevel: 2 })
    expect(decideEscalation({ ...base, level: 2, nowMs: 99 * MIN })).toEqual({ escalate: false })
    expect(escalationLabel('dispatcher', 1)).toBe('chief dispatcher')
    expect(escalationLabel('yard', 2)).toBe('network operations center')
  })

  it('warns the yard once when a delivered but unacknowledged alert’s train is about to arrive', () => {
    const approaching = { ...base, role: 'yard' as const, ackDueAtMs: 600 * MIN, nowMs: 100 * MIN, yardEtaMs: 120 * MIN }
    expect(decideEscalation(approaching)).toEqual({ escalate: true, reason: 'approaching_yard', toLevel: 1 })
    expect(decideEscalation({ ...approaching, alreadyWarnedYard: true })).toEqual({ escalate: false })
    expect(decideEscalation({ ...approaching, yardEtaMs: 200 * MIN })).toEqual({ escalate: false })
  })

  it('never escalates acknowledged alerts or owner notices', () => {
    expect(decideEscalation({ ...base, status: 'acknowledged', nowMs: 99 * MIN })).toEqual({ escalate: false })
    expect(decideEscalation({ ...base, role: 'owner', nowMs: 99 * MIN })).toEqual({ escalate: false })
  })
})
