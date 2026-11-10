import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { MIN } from '../domain/params.js'
import type { PlanMove, YardSnapshot } from '../domain/types.js'
import { T0, assemble, car, carLock, classify, goodPlan, moveLock, resetClock, seqLock, yard } from '../test-support/fixtures.js'
import { retime, validatePlan } from './validate.js'

const codes = (s: YardSnapshot, moves: PlanMove[]) => validatePlan(s, moves).violations.map((v) => v.code)
const sev = (s: YardSnapshot, moves: PlanMove[], code: string) => validatePlan(s, moves).violations.find((v) => v.code === code)?.severity

describe('validator', () => {
  it('passes a valid plan and reports readiness', () => {
    const result = validatePlan(yard(), goodPlan())
    expect(result.violations).toEqual([])
    expect(result.ok).toBe(true)
    expect(result.readiness[0]).toMatchObject({ outboundId: 'O1', cars: 6, lengthFt: 300, tons: 600, status: 'ready' })
    expect(result.readiness[0].slackMin).toBeGreaterThan(0)
  })

  describe('car holds (safety)', () => {
    it('refuses a held car on an assemble move', () => {
      const s = yard()
      s.cars[0].held = true
      expect(codes(s, goodPlan())).toContain('CAR_HOLD')
      expect(sev(s, goodPlan(), 'CAR_HOLD')).toBe('safety')
    })

    it('refuses a held car coupled to a train with no setout planned', () => {
      const s = yard({ cars: [car('c1', 'A', { trackId: 'D1', coupledTo: 'O1', coupledSeq: 1, held: true })] })
      expect(codes(s, [])).toContain('CAR_HOLD')
    })

    it('accepts it once a setout takes the car off', () => {
      const s = yard({ cars: [car('c1', 'A', { trackId: 'D1', coupledTo: 'O1', coupledSeq: 1, held: true })] })
      const setout: PlanMove = { key: 'setout:O1:c1', kind: 'setout', crew: 'trim', carIds: ['c1'], fromTrackId: 'D1', toTrackId: 'C1', blockId: 'A', inboundId: 'I1', outboundId: 'O1', plannedStart: T0, plannedEnd: T0 + 12 * MIN }
      expect(codes(s, [setout])).not.toContain('CAR_HOLD')
    })
  })

  describe('track capacity (physical)', () => {
    it('refuses overfilling a track', () => {
      const s = yard()
      s.tracks.find((t) => t.id === 'C1')!.capacityFt = 100
      expect(codes(s, goodPlan())).toContain('TRACK_CAPACITY')
      expect(sev(s, goodPlan(), 'TRACK_CAPACITY')).toBe('physical')
    })

    it('counts space as free again once a pull finishes', () => {
      // C1 holds exactly the first cut; a second cut fits only after the pull.
      const s = yard()
      s.tracks.find((t) => t.id === 'C1')!.capacityFt = 150
      s.cars = [car('c1', 'A'), car('c2', 'A'), car('c3', 'A'), car('c7', 'A'), car('c8', 'A'), car('c4', 'B')]
      resetClock()
      const moves = [classify('k1', ['c1', 'c2', 'c3'], 'C1', 'A'), assemble('a1', ['c1', 'c2', 'c3'], 'C1', 'D1', 'A'), classify('k2', ['c7', 'c8'], 'C1', 'A')]
      expect(codes(s, moves)).not.toContain('TRACK_CAPACITY')
    })

    it('refuses a blocked track', () => {
      const s = yard()
      s.tracks.find((t) => t.id === 'C1')!.open = false
      expect(codes(s, goodPlan())).toContain('TRACK_BLOCKED')
    })
  })

  describe('standing orders (operating, overridable)', () => {
    it('flags a block outside its standing track and alternates', () => {
      resetClock()
      const moves = [classify('k1', ['c1'], 'C2', 'A')]
      const s = yard({ cars: [car('c1', 'A')] })
      expect(codes(s, moves)).toContain('STANDING_ORDER')
      expect(sev(s, moves, 'STANDING_ORDER')).toBe('operating')
    })

    it('accepts an approved alternate', () => {
      resetClock()
      const s = yard({ cars: [car('c1', 'A')] })
      expect(codes(s, [classify('k1', ['c1'], 'C9', 'A')])).toEqual([])
    })

    it('refuses two blocks on one class track', () => {
      resetClock()
      const s = yard()
      s.blocks[1].alternateTrackIds = ['C1']
      const moves = [classify('k1', ['c1'], 'C1', 'A'), classify('k2', ['c4'], 'C1', 'B')]
      expect(codes(s, moves)).toContain('MIXED_BLOCK')
    })
  })

  describe('departure times (operating, overridable)', () => {
    it('flags a pull whose brake test finishes after departure', () => {
      const s = yard()
      s.outbound[0].departure = T0 + 40 * MIN
      expect(codes(s, goodPlan())).toContain('DEPARTURE_TIME')
      expect(sev(s, goodPlan(), 'DEPARTURE_TIME')).toBe('operating')
    })

    it('does not fail the plan for a move already in progress running late', () => {
      const s = yard()
      s.outbound[0].departure = T0 + 40 * MIN
      resetClock()
      const pull = assemble('a1', ['c1'], 'R1', 'D1', 'A')
      s.cars = [car('c1', 'A')]
      s.executions[pull.key] = { key: pull.key, status: 'in_progress', startedAt: T0, completedAt: null, move: pull }
      expect(codes(s, [{ ...pull, plannedEnd: T0 + 60 * MIN }])).not.toContain('DEPARTURE_TIME')
    })
  })

  describe('train limits', () => {
    it('flags train length as an operating rule', () => {
      const s = yard()
      s.outbound[0].maxLengthFt = 200
      expect(sev(s, goodPlan(), 'TRAIN_LENGTH')).toBe('operating')
    })

    it('refuses train tonnage as a safety rule', () => {
      const s = yard()
      s.outbound[0].maxTons = 300
      expect(sev(s, goodPlan(), 'TRAIN_TONNAGE')).toBe('safety')
    })
  })

  describe('hazmat placement (simplified rules, safety)', () => {
    it('refuses a placarded car without the buffer behind the locomotive', () => {
      const s = yard()
      s.cars[1].hazmatClass = '3'
      expect(codes(s, goodPlan())).toContain('HAZMAT_BUFFER')
      expect(sev(s, goodPlan(), 'HAZMAT_BUFFER')).toBe('safety')
    })

    it('accepts one with enough non-placarded cars ahead of it', () => {
      const s = yard()
      s.cars[5].hazmatClass = '3'
      expect(codes(s, goodPlan())).toEqual([])
    })

    it('refuses incompatible placards side by side', () => {
      const s = yard()
      s.cars.push(car('c7', 'B', { hazmatClass: '3' }), car('c8', 'B', { hazmatClass: '1.1' }))
      resetClock()
      const moves = [...goodPlan().slice(0, 3), assemble('assemble:O1:B', ['c4', 'c5', 'c6', 'c7', 'c8'], 'R1', 'D1', 'B')]
      expect(codes(s, moves)).toContain('HAZMAT_ADJACENT')
    })
  })

  describe('physical sequence', () => {
    it('refuses coupling blocks out of the train sequence', () => {
      const [k1, k2, a1, a2] = goodPlan()
      expect(codes(yard(), [k1, k2, a2, a1])).toContain('BLOCK_SEQUENCE')
    })

    it('refuses pulling cars before they have been classified', () => {
      const [k1, k2, a1, a2] = goodPlan()
      expect(codes(yard(), [a1, k1, k2, a2])).toContain('MOVE_PRECEDENCE')
    })

    it('refuses a car of a block the train does not take', () => {
      const s = yard()
      s.outbound[0].blockSequence = ['B']
      expect(codes(s, goodPlan())).toContain('WRONG_BLOCK')
    })

    it('refuses a car crews could not find', () => {
      const s = yard()
      s.cars[0].position = 'unknown'
      s.cars[0].trackId = null
      expect(codes(s, goodPlan())).toContain('MOVE_PRECEDENCE')
    })

    it('refuses the same move twice', () => {
      const plan = goodPlan()
      expect(codes(yard(), [...plan, plan[0]])).toContain('DUPLICATE_MOVE')
    })

    it('refuses two trains on a departure track at once', () => {
      const s = yard()
      s.outbound.push({ ...s.outbound[0], id: 'O2', symbol: 'M-2', blockSequence: ['B'] })
      resetClock()
      const moves = [classify('k1', ['c1', 'c2', 'c3'], 'C1', 'A'), classify('k2', ['c4', 'c5', 'c6'], 'C2', 'B'), assemble('a1', ['c1', 'c2', 'c3'], 'C1', 'D1', 'A'), assemble('a2', ['c4', 'c5', 'c6'], 'C2', 'D1', 'B', 'O2')]
      expect(codes(s, moves)).toContain('TRACK_CONFLICT')
    })

    it('refuses one train on two departure tracks', () => {
      resetClock()
      const moves = [classify('k1', ['c1', 'c2', 'c3'], 'C1', 'A'), classify('k2', ['c4', 'c5', 'c6'], 'C2', 'B'), assemble('a1', ['c1', 'c2', 'c3'], 'C1', 'D1', 'A'), assemble('a2', ['c4', 'c5', 'c6'], 'C2', 'D2', 'B')]
      expect(codes(yard(), moves)).toContain('TRAIN_SPLIT')
    })
  })

  describe('frozen moves', () => {
    it('refuses changing a move that has started', () => {
      const plan = goodPlan()
      const s = yard()
      s.executions[plan[0].key] = { key: plan[0].key, status: 'in_progress', startedAt: T0, completedAt: null, move: plan[0] }
      const edited = [{ ...plan[0], toTrackId: 'C9' }, ...plan.slice(1)]
      expect(codes(s, edited)).toContain('FROZEN_CHANGED')
    })

    it('refuses removing a move that already happened', () => {
      const plan = goodPlan()
      const s = yard()
      s.executions[plan[0].key] = { key: plan[0].key, status: 'done', startedAt: T0, completedAt: T0, move: plan[0] }
      expect(codes(s, plan.slice(1))).toContain('FROZEN_CHANGED')
    })
  })

  describe('locks', () => {
    it('flags a locked move the plan changed', () => {
      const plan = goodPlan()
      const s = yard({ locks: [moveLock('l1', { ...plan[0], toTrackId: 'C9' })] })
      expect(codes(s, plan)).toContain('LOCK_VIOLATED')
    })

    it('accepts a locked move the plan kept', () => {
      const plan = goodPlan()
      expect(codes(yard({ locks: [moveLock('l1', plan[0])] }), plan)).toEqual([])
    })

    it('flags a car locked to another track', () => {
      expect(codes(yard({ locks: [carLock('l1', 'c1', 'C9')] }), goodPlan())).toContain('LOCK_VIOLATED')
    })

    it('flags a broken sequence pin', () => {
      const plan = goodPlan()
      expect(codes(yard({ locks: [seqLock('l1', plan[1].key, plan[0].key)] }), plan)).toContain('LOCK_VIOLATED')
    })
  })

  describe('retime', () => {
    it('lets a dragged move really go earlier, and pushes the rest', () => {
      const [k1, k2, a1, a2] = goodPlan()
      const s = yard()
      const timed = retime(s, [k2, k1, a1, a2], new Set([k2.key]))
      expect(timed[0].plannedStart).toBe(T0)
      expect(timed[1].plannedStart).toBeGreaterThanOrEqual(timed[0].plannedEnd)
      expect(validatePlan(s, timed).violations.map((v) => v.code)).not.toContain('MOVE_PRECEDENCE')
    })

    it('keeps start times in list order', () => {
      const s = yard()
      const timed = retime(s, goodPlan(), new Set())
      for (let i = 1; i < timed.length; i++) expect(timed[i].plannedStart).toBeGreaterThanOrEqual(timed[i - 1].plannedStart)
    })
  })

  it('shares no code with the planner', () => {
    const here = dirname(fileURLToPath(import.meta.url))
    for (const file of readdirSync(here).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))) {
      const source = readFileSync(join(here, file), 'utf8')
      const imports = [...source.matchAll(/^import\s+(type\s+)?.*?from\s+'([^']+)'/gm)]
      for (const [, isType, path] of imports) {
        expect(path).not.toContain('planner')
        // Only types may cross the folder boundary, so no logic can be shared by accident.
        if (path.startsWith('..')) expect(isType, `${file} imports ${path}`).toBeTruthy()
      }
    }
  })
})
