/**
 * The demo story, run in-process through the real services:
 *
 *   Shift 1 runs to the end under simulated crews, including two yardmaster
 *   overrides, and closes, so the metrics page has a finished shift.
 *
 *   Shift 2 stops partway, in the state the screenshots show:
 *     - alice reorders a move and locks another
 *     - carol knowingly overrides a standing order, with a reason
 *     - a hold from #19 lands on a car in the plan, and a crew's start is refused
 *     - dave reports a car that isn't where expected
 *     - an inbound train slips 3 hours: a stable replan, a from-scratch comparison
 *       and a missed departure the yardmaster has to see
 *     - a hold lands on a car already coupled to a train
 *     - carol locks a car to a track that's then blocked: a conflict left open
 *
 *   Then the planner comparison and a seeded replay run, so those pages have data.
 * @module db/demo
 */
import { randomUUID } from 'node:crypto'
import { applyEdit } from '../plans/edits.js'
import { createLock } from '../plans/locks.js'
import { applyCrewReport } from '../execution/reports.js'
import { reviseDeparture } from '../execution/yard-events.js'
import { solve } from '../planner/solve.js'
import { readSnapshot } from '../plans/snapshot.js'
import { makeHoldEvent, applyHoldEvent } from '../holds/apply.js'
import { shiftStart } from '../domain/scenario.js'
import { withTransaction, pool } from '../shared/db.js'
import { publishOrRecompute, loadMoves } from '../plans/versions.js'
import { readYard } from '../plans/state.js'
import { directPort, type SimView } from '../simulator/port.js'
import { YardSimulator } from '../simulator/engine.js'
import { runComparison, executeReplay } from '../worker/run-analysis.js'
import type { ClaimedJob } from '../worker/jobs.js'

type Sim = YardSimulator
const port = directPort()

async function working() {
  const yard = await readYard(pool)
  if (!yard.workingVersionId) throw new Error('no working plan')
  const { rows } = await pool.query(`SELECT version_no FROM switch_lists WHERE id = $1`, [yard.workingVersionId])
  const moves = await loadMoves(pool, yard.workingVersionId)
  return { id: yard.workingVersionId, versionNo: rows[0].version_no as number, moves, yard }
}

async function publishWorking(by: string) {
  const w = await working()
  await publishOrRecompute(w.id, { by })
}

/** Reorders a pending hump move up the list, trying candidates until the validator accepts one. */
async function reorderSomething(by: string, reason: string, code: string): Promise<string | null> {
  const w = await working()
  const view = await port.view()
  const pendingKeys = new Set(view.moves.filter((m) => m.status === 'pending').map((m) => m.key))
  const hump = w.moves.map((m, i) => ({ m, i })).filter(({ m }) => m.crew === 'hump' && pendingKeys.has(m.key))
  let lastError = 'no candidates'
  for (let k = hump.length - 1; k >= 1; k--) {
    const target = hump[k]
    const before = hump[k - 1]
    try {
      await withTransaction((client) => applyEdit(client, w.id, { expectedVersionNo: w.versionNo, ops: [{ op: 'reorder', moveKey: target.m.key, toIndex: before.i }], reason, reasonCode: code }, by))
      return target.m.key
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
    }
  }
  console.log('demo: no reorder accepted:', lastError)
  return null
}

/** Moves simulated time forward until the condition holds. */
async function stepUntil(sim: Sim, condition: () => Promise<boolean>, maxMinutes: number): Promise<boolean> {
  for (let m = 0; m < maxMinutes; m += 5) {
    if (await condition()) return true
    await sim.step(5, 5)
    await publishPending('alice')
  }
  return condition()
}

async function lockMove(by: string, key: string, reason: string, code: string) {
  await withTransaction((client) => createLock(client, { kind: 'move', moveKey: key, reason, reasonCode: code }, by))
}

async function shiftOne(sim: Sim) {
  await sim.step(120, 5)
  const moved = await reorderSomething('alice', 'Keep the Galesburg cut ahead of the crew change', 'crew_availability')
  if (moved) await publishWorking('alice')
  await sim.step(180, 5)
  await sim.lateTrain(await port.view(), undefined, 90)
  await port.settle()
  await publishPending('carol')
  await sim.step(450, 5)
  await publishPending('carol')
  sim.autoRoll = false
  await sim.step(10, 5)
  await port.nextShift()
  await port.settle()
  await publishPending('alice')
}

/** A replan that stopped for review gets looked at and published, as a yardmaster would. */
async function publishPending(by: string) {
  const yard = await readYard(pool)
  if (yard.workingVersionId && yard.workingVersionId !== yard.headVersionId) {
    await publishOrRecompute(yard.workingVersionId, { by }).catch(() => undefined)
    await port.settle()
  }
}

/** Which late train would hurt most? Tries each one against the current plan, the way a dispatcher's what-if would. */
async function worstTrainToSlip(minutes: number): Promise<string | null> {
  const snapshot = await readSnapshot()
  const w = await working()
  let best: { id: string; score: number } | null = null
  for (const i of snapshot.inbound) {
    if (i.actualArrival !== null) continue
    const trial = { ...snapshot, inbound: snapshot.inbound.map((x) => (x.id === i.id ? { ...x, eta: x.eta + minutes * 60_000 } : x)) }
    const result = await solve(trial, { algorithm: 'local_search', timeLimitMs: 800, iterationLimit: 400, seed: 1, baseline: w.moves, stable: true })
    const missed = result.consequences.filter((c) => c.kind === 'departure_missed' && c.reason === 'was_planned').length
    const rolled = result.consequences.filter((c) => c.kind === 'cars_rolled').reduce((sum, c) => sum + (c.carIds?.length ?? 0), 0)
    const score = missed * 1000 + rolled
    if (!best || score > best.score) best = { id: i.id, score }
  }
  return best?.id ?? null
}

function firstPending(view: SimView, predicate: (m: SimView['moves'][number]) => boolean) {
  return view.moves.find((m) => m.status === 'pending' && predicate(m))
}

async function placeHold(sim: Sim, carId: string, reason: string) {
  const caseId = randomUUID()
  const event = makeHoldEvent({ eventId: randomUUID(), type: 'CarHoldPlaced', holdId: `hold-${caseId.slice(0, 8)}`, carId, caseId, streamVersion: 1, occurredAt: new Date(sim.now).toISOString(), reason })
  await withTransaction((client) => applyHoldEvent(client, event, 'seed'))
  return event
}

async function shiftTwo(sim: Sim) {
  sim.exceptionRate = 0
  await sim.step(60, 5)
  await publishPending('alice')

  // Alice reorders a move and locks it.
  const moved = await reorderSomething('alice', 'Hump this cut first: its crew is already on the lead', 'crew_availability')
  if (moved) await lockMove('alice', moved, 'This cut stays where I put it', 'crew_availability')
  await publishWorking('alice')
  await sim.step(25, 5)
  await publishPending('alice')

  // Carol knowingly sends a cut outside its standing order, with a reason.
  const w = await working()
  let view = await port.view()
  const pendingHump = w.moves.filter((m) => m.kind === 'classify' && view.moves.some((v) => v.key === m.key && v.status === 'pending') && m.key !== moved)
  for (const m of [...pendingHump].reverse()) {
    const free = w.moves.filter((x) => x.kind === 'classify').map((x) => x.toTrackId)
    const target = ['C9', 'C10', 'C8', 'C7', 'C6'].find((t) => !free.includes(t) && t !== m.toTrackId)
    if (!target) break
    try {
      await withTransaction((client) => applyEdit(client, w.id, { expectedVersionNo: w.versionNo, ops: [{ op: 'retarget', moveKey: m.key, toTrackId: target }], reason: `${m.toTrackId} has a soft spot at the east switch; use ${target} for now`, reasonCode: 'track_condition', overrideSoft: true }, 'carol'))
      await publishWorking('carol')
      break
    } catch {
      continue
    }
  }
  await sim.step(10, 5)

  // Dave can't find a car.
  view = await port.view()
  const cut = firstPending(view, (m) => m.kind === 'classify' && m.ready && m.carIds.length > 1)
  if (cut) {
    const missing = cut.carIds[cut.carIds.length - 1]
    await withTransaction((client) => applyCrewReport(client, { clientReportId: `demo-missing-${randomUUID()}`, moveKey: cut.key, kind: 'exception', exceptionType: 'car_not_found', carIds: [missing], note: 'Not on the track; last seen on the lead', occurredAt: new Date(sim.now).toISOString() }, 'dave'))
    await port.settle()
    await publishPending('alice')
  }

  // An inbound train slips three hours: the one that hurts most, so there's a consequence to see.
  const worst = await worstTrainToSlip(180)
  if (worst) {
    await sim.lateTrain(await port.view(), worst, 180)
    await port.settle()
    await publishPending('alice')
  }

  // A hold from #19 lands on a car in the plan. The planner takes it out; a crew still working from the old list is refused.
  let holdTarget: SimView['moves'][number] | undefined
  await stepUntil(
    sim,
    async () => {
      holdTarget = firstPending(await port.view(), (m) => m.kind === 'assemble' && m.ready)
      return Boolean(holdTarget)
    },
    240,
  )
  if (holdTarget) {
    await placeHold(sim, holdTarget.carIds[0], 'Hot bearing trend at HBD-112')
    const refused = await withTransaction((client) => applyCrewReport(client, { clientReportId: `demo-refused-${randomUUID()}`, moveKey: (holdTarget as SimView['moves'][number]).key, kind: 'start', occurredAt: new Date(sim.now).toISOString() }, 'dave'))
    if (refused.outcome !== 'refused_hold') console.log('demo: expected a refused start, got', refused.outcome)
    await port.settle()
    await publishPending('alice')
  }

  // A hold lands on a car already coupled to a train.
  const coupledCar = async () => (await pool.query(`SELECT c.id FROM cars c JOIN outbound_trains o ON o.id = c.coupled_to WHERE c.position = 'on_track' AND o.status = 'planned' ORDER BY c.coupled_seq DESC LIMIT 1`)).rows[0]?.id as string | undefined
  await stepUntil(sim, async () => Boolean(await coupledCar()), 120)
  const coupled = await coupledCar()
  if (coupled) {
    await placeHold(sim, coupled, 'Cold wheel flagged by a wayside detector after coupling')
    await port.settle()
    await publishPending('alice')
  }

  // Carol holds a train for a late cut: a knowing, recorded override of an operating rule.
  view = await port.view()
  const toHoldTrain = view.outbound.find((o) => o.status === 'planned' && new Date(o.departure).getTime() > sim.now + 60 * 60_000)
  if (toHoldTrain) {
    const later = new Date(new Date(toHoldTrain.departure).getTime() + 25 * 60_000).toISOString()
    await withTransaction((client) => reviseDeparture(client, toHoldTrain.id, later, 'carol', 'Road crew is on rest until then, so the train can wait for the late cut', 'crew_availability'))
    await port.settle()
    await publishPending('carol')
  }
  await sim.step(10, 5)

  // Carol locks a car to a track that then gets blocked: left open for the board to show.
  view = await port.view()
  const laterCut = [...view.moves].reverse().find((m) => m.kind === 'classify' && m.status === 'pending' && m.carIds.length > 0)
  if (laterCut) {
    const carId = laterCut.carIds[0]
    await withTransaction((client) => createLock(client, { kind: 'car_track', carId, trackId: laterCut.toTrackId, reason: 'Customer asked for this car to stay with its block on the standing track', reasonCode: 'customer_priority' }, 'carol'))
    await port.settle()
    await sim.blockTrack(laterCut.toTrackId, null, 'Switch points fouled by ballast')
    await port.settle()
  }
}

const analysisJob = (params: Record<string, unknown>): ClaimedJob => ({ id: randomUUID(), shiftId: 2, lane: 'analysis', purpose: 'compare', algorithm: 'compare', reason: 'seed', timeLimitMs: 0, iterationLimit: 0, seed: 1, params, attempts: 1, leaseToken: 'seed', reclaimed: false })

export async function runDemo(): Promise<void> {
  const t0 = Date.now()
  await port.settle()
  const yard = await readYard(pool)
  const sim = new YardSimulator(port, { seed: yard.seed, exceptionRate: 0.015, autoRoll: false })
  sim.now = shiftStart(1)
  console.log('Demo: running shift 1 to its end...')
  await shiftOne(sim)
  console.log(`Demo: shift 2 story (${Math.round((Date.now() - t0) / 1000)} s so far)...`)
  sim.now = Math.max(sim.now, shiftStart(2))
  await shiftTwo(sim)
  if (process.env.SEED_SKIP_ANALYSIS !== '1') {
    console.log(`Demo: planner comparison and replay (${Math.round((Date.now() - t0) / 1000)} s so far)...`)
    await runComparison(analysisJob({ smallInstances: 6, exactLimitMs: 4000, fullLimits: [100, 500, 2000, 5000] }))
    await executeReplay([42, 7, 11, 23], 500, null)
  }
  const final = await readYard(pool)
  const now = new Date(sim.now).toISOString()
  console.log(`Demo finished in ${Math.round((Date.now() - t0) / 1000)} s: shift ${final.shiftId}, state v${final.stateVersion}, sim clock ${now}`)
}
