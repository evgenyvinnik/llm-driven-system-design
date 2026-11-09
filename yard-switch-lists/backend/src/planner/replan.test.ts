import { describe, expect, it } from 'vitest'
import { countDisturbed } from '../domain/diff.js'
import { MIN } from '../domain/params.js'
import { initialSnapshot } from '../domain/scenario.js'
import type { PlanMove, YardSnapshot } from '../domain/types.js'
import { carLock, moveLock, seqLock } from '../test-support/fixtures.js'
import { validatePlan } from '../validator/validate.js'
import { solve } from './solve.js'

const fast = { algorithm: 'local_search' as const, timeLimitMs: 30_000, iterationLimit: 300 }

async function firstPlan(seed = 42): Promise<{ snap: YardSnapshot; plan: PlanMove[] }> {
  const snap = initialSnapshot(seed)
  const { moves } = await solve(snap, { ...fast, seed })
  return { snap, plan: moves }
}

/** Marks the earliest crew moves done and one in progress, and moves their cars as a crew report would. */
function execute(snap: YardSnapshot, plan: PlanMove[], doneCount: number): { done: PlanMove[]; running: PlanMove } {
  for (const i of snap.inbound.filter((x) => x.eta <= snap.now + 90 * MIN)) {
    i.actualArrival = i.eta
    const receive = plan.find((m) => m.key === `receive:${i.id}`)!
    i.receivingTrackId = receive.toTrackId
    for (const c of snap.cars.filter((x) => x.inboundId === i.id)) {
      c.position = 'on_track'
      c.trackId = receive.toTrackId
      c.arrivedAt = i.eta
    }
    snap.executions[receive.key] = { key: receive.key, status: 'done', startedAt: i.eta, completedAt: i.eta, move: receive }
  }
  const arrived = new Set(snap.inbound.filter((i) => i.actualArrival !== null).map((i) => i.id))
  const crewMoves = plan.filter((m) => m.kind === 'classify' && m.inboundId && arrived.has(m.inboundId))
  const done = crewMoves.slice(0, doneCount)
  for (const m of done) {
    snap.executions[m.key] = { key: m.key, status: 'done', startedAt: m.plannedStart, completedAt: m.plannedEnd, move: m }
    for (const id of m.carIds) snap.cars.find((c) => c.id === id)!.trackId = m.toTrackId
  }
  const running = crewMoves[doneCount]
  snap.executions[running.key] = { key: running.key, status: 'in_progress', startedAt: running.plannedStart, completedAt: null, move: running }
  snap.now = running.plannedStart + MIN
  return { done, running }
}

function slip(snap: YardSnapshot, minutes: number) {
  const train = snap.inbound.find((i) => i.actualArrival === null)!
  train.eta += minutes * MIN
  return train
}

describe('replanning after a train slips three hours', () => {
  it('leaves done and in-progress moves exactly as they were', async () => {
    const { snap, plan } = await firstPlan()
    const { done, running } = execute(snap, plan, 3)
    slip(snap, 180)
    const { moves } = await solve(snap, { ...fast, seed: 2, baseline: plan, stable: true })
    for (const m of [...done, running]) {
      const after = moves.find((x) => x.key === m.key)!
      expect(after.toTrackId).toBe(m.toTrackId)
      expect(after.carIds).toEqual(m.carIds)
    }
    expect(validatePlan(snap, moves).violations).toEqual([])
  })

  it('keeps pending moves inside the frozen horizon unless a fact forces a change', async () => {
    const { snap, plan } = await firstPlan()
    execute(snap, plan, 2)
    slip(snap, 180)
    const horizonEnd = snap.now + snap.rules.frozenHorizonMin * MIN
    const inHorizon = plan.filter((m) => !snap.executions[m.key] && m.kind === 'classify' && m.plannedStart <= horizonEnd)
    const { moves, consequences } = await solve(snap, { ...fast, seed: 2, baseline: plan, stable: true })
    expect(inHorizon.length).toBeGreaterThan(0)
    for (const m of inHorizon) {
      const reported = consequences.some((c) => c.kind === 'frozen_move_changed' && c.moveKey === m.key)
      const after = moves.find((x) => x.key === m.key)
      if (!reported) expect(after?.toTrackId).toBe(m.toTrackId)
    }
  })

  it('changes measurably fewer moves than replanning from scratch', async () => {
    let stableTotal = 0
    let scratchTotal = 0
    for (const seed of [42, 7, 11]) {
      const { snap, plan } = await firstPlan(seed)
      execute(snap, plan, 2)
      slip(snap, 180)
      const stable = await solve(snap, { ...fast, seed: 2, baseline: plan, stable: true })
      const scratch = await solve(snap, { ...fast, seed: 3 })
      stableTotal += countDisturbed(plan, stable.moves, stable.problem.frozenKeys).disturbed
      scratchTotal += countDisturbed(plan, scratch.moves, scratch.problem.frozenKeys).disturbed
    }
    expect(stableTotal).toBeLessThan(scratchTotal)
  }, 60_000)

  it('reports a train that now misses its departure instead of absorbing it', async () => {
    // With the early trains needing most of the cars on this one train, a slip costs a departure.
    const { snap, plan } = await firstPlan(11)
    const victims = []
    for (const i of snap.inbound.slice(1, 5)) {
      const trial = { ...snap, inbound: snap.inbound.map((x) => (x.id === i.id ? { ...x, eta: x.eta + 180 * MIN } : x)) }
      const { consequences } = await solve(trial, { ...fast, seed: 2, baseline: plan, stable: true })
      victims.push(...consequences.filter((c) => c.kind === 'departure_missed' && c.reason === 'was_planned'))
    }
    expect(victims.length).toBeGreaterThan(0)
    expect(victims[0].message).toMatch(/misses its .* departure/)
    expect(victims[0].outboundId).toBeTruthy()
  }, 60_000)

  it('names the rolled cars and where they went', async () => {
    const { snap, plan } = await firstPlan(11)
    slip(snap, 180)
    const { consequences } = await solve(snap, { ...fast, seed: 2, baseline: plan, stable: true })
    const rolled = consequences.filter((c) => c.kind === 'cars_rolled')
    for (const c of rolled) {
      expect(c.carIds?.length).toBeGreaterThan(0)
      expect(c.message).toMatch(/moved from|rolled off/)
    }
  })
})

describe('locks', () => {
  it('keeps a locked move through a replan', async () => {
    const { snap, plan } = await firstPlan()
    const pick = plan.filter((m) => m.kind === 'classify')[8]
    snap.locks = [moveLock('l1', pick)]
    slip(snap, 180)
    const { moves, conflicts } = await solve(snap, { ...fast, seed: 2, baseline: plan, stable: true })
    expect(conflicts).toEqual([])
    const kept = moves.find((m) => m.key === pick.key)!
    expect(kept.toTrackId).toBe(pick.toTrackId)
    expect(kept.carIds).toEqual(pick.carIds)
  })

  it('keeps a yardmaster reorder through a replan, even one from scratch', async () => {
    const { snap, plan } = await firstPlan()
    const hump = plan.filter((m) => m.kind === 'classify' && m.inboundId === plan.find((x) => x.kind === 'classify')!.inboundId)
    const [first, second] = [hump[1], hump[0]]
    snap.locks = [seqLock('l1', first.key, second.key)]
    const { moves, conflicts } = await solve(snap, { ...fast, seed: 5 })
    expect(conflicts).toEqual([])
    expect(moves.findIndex((m) => m.key === first.key)).toBeLessThan(moves.findIndex((m) => m.key === second.key))
    expect(validatePlan(snap, moves).ok).toBe(true)
  })

  it('routes a car to the track it is locked to, splitting it off its cut', async () => {
    const { snap } = await firstPlan()
    const c = snap.cars.find((x) => x.blockId === 'KCK')!
    snap.locks = [carLock('l1', c.id, 'C9')]
    const { moves, conflicts } = await solve(snap, { ...fast, seed: 4 })
    expect(conflicts).toEqual([])
    expect(moves.find((m) => m.kind === 'classify' && m.carIds.includes(c.id))?.toTrackId).toBe('C9')
  })

  it('surfaces a lock onto a blocked track as a conflict and keeps the lock', async () => {
    const { snap, plan } = await firstPlan()
    const c = snap.cars.find((x) => x.blockId === 'KCK')!
    snap.locks = [carLock('l1', c.id, 'C9')]
    snap.tracks.find((t) => t.id === 'C9')!.open = false
    const { conflicts, moves } = await solve(snap, { ...fast, seed: 4, baseline: plan, stable: true })
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]).toMatchObject({ code: 'LOCK_TRACK_BLOCKED', lockId: 'l1' })
    expect(conflicts[0].options).toContain('release_lock')
    // The validator independently refuses the plan until someone resolves it.
    expect(validatePlan(snap, moves).violations.map((v) => v.code)).toContain('LOCK_VIOLATED')
  })

  it('surfaces a lock whose car went on hold: the hold wins', async () => {
    const { snap, plan } = await firstPlan()
    const pick = plan.filter((m) => m.kind === 'classify')[5]
    snap.locks = [moveLock('l1', pick)]
    snap.cars.find((c) => c.id === pick.carIds[0])!.held = true
    const { conflicts, moves } = await solve(snap, { ...fast, seed: 4, baseline: plan, stable: true })
    expect(conflicts[0]).toMatchObject({ code: 'LOCK_HELD_CAR' })
    expect(moves.some((m) => m.kind !== 'receive' && m.carIds.includes(pick.carIds[0]))).toBe(false)
  })

  it('surfaces a lock on too small a track as a capacity conflict', async () => {
    const { snap } = await firstPlan()
    const c = snap.cars.find((x) => x.blockId === 'KCK')!
    snap.locks = [carLock('l1', c.id, 'C9')]
    snap.tracks.find((t) => t.id === 'C9')!.capacityFt = 10
    const { conflicts } = await solve(snap, { ...fast, seed: 4 })
    expect(conflicts[0]).toMatchObject({ code: 'LOCK_CAPACITY' })
  })
})

describe('holds and exceptions in a replan', () => {
  it('sets a held car off the train it is coupled to', async () => {
    const snap = initialSnapshot(42)
    const c = snap.cars.find((x) => x.blockId === snap.outbound[0].blockSequence[0])!
    Object.assign(c, { position: 'on_track', trackId: 'D1', coupledTo: snap.outbound[0].id, coupledSeq: 1, held: true })
    const { moves } = await solve(snap, { ...fast, seed: 2 })
    const setout = moves.find((m) => m.kind === 'setout')!
    expect(setout.carIds).toEqual([c.id])
    expect(validatePlan(snap, moves).violations.map((v) => v.code)).not.toContain('CAR_HOLD')
  })

  it('never reuses the key of a move that was cancelled', async () => {
    const { snap, plan } = await firstPlan()
    const m = plan.filter((x) => x.kind === 'classify')[4]
    snap.executions[m.key] = { key: m.key, status: 'cancelled', startedAt: null, completedAt: null, move: m }
    const { moves } = await solve(snap, { ...fast, seed: 2, baseline: plan, stable: true })
    expect(moves.some((x) => x.key === m.key)).toBe(false)
    expect(moves.some((x) => x.key.startsWith(`${m.key}#`))).toBe(true)
  })

  it('plans around a car crews could not find, and reports it', async () => {
    const { snap, plan } = await firstPlan()
    const c = snap.cars[0]
    c.position = 'unknown'
    const { moves, consequences } = await solve(snap, { ...fast, seed: 2, baseline: plan, stable: true })
    expect(moves.some((m) => m.kind !== 'receive' && m.carIds.includes(c.id))).toBe(false)
    expect(consequences.some((x) => x.kind === 'cars_unassigned' && x.carIds?.includes(c.id))).toBe(true)
  })

  it('stays off a blocked track', async () => {
    const { snap, plan } = await firstPlan()
    snap.tracks.find((t) => t.id === 'C1')!.open = false
    const { moves } = await solve(snap, { ...fast, seed: 2, baseline: plan, stable: true })
    expect(moves.some((m) => m.toTrackId === 'C1')).toBe(false)
    expect(validatePlan(snap, moves).violations).toEqual([])
  })
})
