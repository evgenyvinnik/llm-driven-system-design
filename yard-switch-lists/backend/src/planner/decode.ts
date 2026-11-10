/**
 * The decoder: decisions in, a feasible timed move list out.
 *
 * A candidate only says which train each group rides, which track each cut
 * prefers, and in what order crews should work. This turns that into moves with
 * a discrete-event list schedule: at each step the crew whose next move can
 * start soonest gets it, so start times never go backwards and the list reads
 * in the order crews are released.
 *
 * Hard constraints are enforced here by construction: a car that can't legally
 * go is spilled to the next train that serves its block, or left unassigned and
 * paid for in the objective. The search therefore never sees an infeasible plan,
 * and the validator, which shares none of this code, checks that claim.
 * @module planner/decode
 */
import { MIN, WEIGHTS, moveDurationMin } from '../domain/params.js'
import { countDisturbed } from '../domain/diff.js'
import type { CarState, CostBreakdown, MoveDiffCounts, OutboundDef, PlanMove } from '../domain/types.js'
import type { Cut, FixedAssemble, Problem } from './problem.js'

export interface Candidate {
  groupTrain: Record<string, string | null>
  cutTrack: Record<string, string>
  classifyOrder: string[]
  trainOrder: string[]
  departureTrack: Record<string, string>
}

export interface TrainOutcome {
  id: string
  cars: number
  lengthFt: number
  tons: number
  readyAt: number | null
  annulled: boolean
  coupled: number
}

export interface Decoded {
  moves: PlanMove[]
  allMoves: PlanMove[]
  assignment: Record<string, string | null>
  unassigned: { carId: string; reason: string }[]
  trains: Record<string, TrainOutcome>
  annulled: string[]
  cost: CostBreakdown
  changes: MoveDiffCounts | null
  droppedFixed: { key: string; lockId: string | null; reason: string; pinned: boolean }[]
}

interface Slot {
  blockId: string
  cars: CarState[]
  fixed: FixedAssemble[]
  activated: boolean
  groups: { trackId: string; cars: CarState[]; fixed: FixedAssemble | null }[]
  index: number
  /** Cached readiness of this slot's cars, recomputed only when feeders change. */
  cacheVersion: number
  cacheKnown: boolean
  cacheReady: number
}

interface TrainRun {
  def: OutboundDef
  slots: Slot[]
  next: number
  lengthFt: number
  tons: number
  count: number
  beforeHaz: number
  sawHaz: boolean
  lastClass: string | null
  depTrack: string | null
  readyAt: number | null
  retryAt: number
  moveSeq: Record<string, number>
  /** The counters above hold everything reserved; this holds only what has really been emitted as moves. */
  committed: Counters
}

interface Counters {
  lengthFt: number
  tons: number
  count: number
  beforeHaz: number
  sawHaz: boolean
  lastClass: string | null
}

interface Release {
  t: number
  track: string
  ft: number
  blockId: string | null
  count: number
}

const INF = Number.POSITIVE_INFINITY

function decodeOnce(p: Problem, c: Candidate, annulled: Set<string>): Decoded {
  const r = p.rules
  const now = p.now
  const ft: Record<string, number> = { ...p.initialFt }
  // Cars per block per class track, plus a running total so "any other block here?" is O(1).
  const onTrack: Record<string, Record<string, number>> = {}
  const onTrackTotal: Record<string, number> = {}
  for (const id of Object.keys(p.initialBlocks)) {
    onTrack[id] = { ...p.initialBlocks[id] }
    let total = 0
    for (const b in onTrack[id]) total += onTrack[id][b]
    onTrackTotal[id] = total
  }
  const releases: Release[] = [...p.initialReleases]
  releases.sort((a, b) => a.t - b.t)
  let releaseAt = 0

  // An attempt looks at the yard as of its own start time, and most attempts commit. One that
  // places nothing must leave the yard as it found it, or a later move that starts earlier
  // would see space that isn't free yet. So releases applied during an attempt are journaled.
  const journal: { rel: Release; taken: number }[] = []
  const applyReleases = (t: number) => {
    while (releaseAt < releases.length && releases[releaseAt].t <= t) {
      const rel = releases[releaseAt++]
      ft[rel.track] -= rel.ft
      let taken = 0
      if (rel.blockId && (onTrack[rel.track]?.[rel.blockId] ?? 0) > 0) {
        taken = Math.min(rel.count, onTrack[rel.track][rel.blockId])
        onTrack[rel.track][rel.blockId] -= taken
        onTrackTotal[rel.track] -= taken
      }
      journal.push({ rel, taken })
    }
  }
  const undoReleases = () => {
    while (journal.length > 0) {
      const { rel, taken } = journal.pop() as { rel: Release; taken: number }
      releaseAt--
      ft[rel.track] += rel.ft
      if (taken > 0 && rel.blockId) {
        onTrack[rel.track][rel.blockId] += taken
        onTrackTotal[rel.track] += taken
      }
    }
  }
  const addRelease = (rel: Release) => {
    let i = releases.length
    while (i > releaseAt && releases[i - 1].t > rel.t) i--
    releases.splice(i, 0, rel)
  }
  const nextReleaseOn = (allowed: (track: string) => boolean): number => {
    for (let i = releaseAt; i < releases.length; i++) if (allowed(releases[i].track)) return releases[i].t
    return INF
  }

  const carReady: Record<string, number> = { ...p.carReadyAt }
  const carTrack: Record<string, string> = { ...p.carTrackAt }
  const inboundReady: Record<string, number> = { ...p.inboundReady }
  const inboundTrack: Record<string, string> = {}
  for (const i of p.snap.inbound) if (i.receivingTrackId) inboundTrack[i.id] = i.receivingTrackId
  for (const cut of p.cuts) for (const car of cut.cars) if (carReady[car.id] === undefined) carReady[car.id] = INF

  const moves: PlanMove[] = []
  const unassigned: { carId: string; reason: string }[] = [...p.preUnassigned]
  const assignment: Record<string, string | null> = {}
  const droppedFixed: Decoded['droppedFixed'] = []
  const scheduled = new Set<string>(p.frozenKeys)
  let lastStart = now
  let humpFree = p.crewFree.hump
  let trimFree = p.crewFree.trim

  // ── Train runs and slots ───────────────────────────────────────────────
  const runs: Record<string, TrainRun> = {}
  for (const t of p.trains) {
    const run: TrainRun = {
      def: t,
      slots: t.blockSequence.map((blockId, index) => ({ blockId, cars: [], fixed: [], activated: false, groups: [], index, cacheVersion: -1, cacheKnown: false, cacheReady: 0 })),
      next: 0,
      lengthFt: 0,
      tons: 0,
      count: 0,
      beforeHaz: 0,
      sawHaz: false,
      lastClass: null,
      depTrack: null,
      readyAt: null,
      retryAt: 0,
      moveSeq: {},
      committed: { lengthFt: 0, tons: 0, count: 0, beforeHaz: 0, sawHaz: false, lastClass: null },
    }
    for (const car of p.coupled[t.id] ?? []) {
      recordOnTrain(run, car)
      recordOnTrain(run.committed, car)
      const idx = t.blockSequence.indexOf(car.blockId)
      if (idx > run.next) run.next = idx
      run.depTrack = carTrack[car.id] ?? car.trackId
      assignment[car.id] = t.id
    }
    runs[t.id] = run
  }

  function recordOnTrain(on: Counters, car: CarState) {
    on.lengthFt += car.lengthFt
    on.tons += car.tons
    on.count++
    if (car.hazmatClass) {
      on.sawHaz = true
      on.lastClass = car.hazmatClass
    } else {
      if (!on.sawHaz) on.beforeHaz++
      on.lastClass = null
    }
  }

  // ── Assignment, with spill to the next train that serves the block ─────
  const carLeadMin = (n: number) => (moveDurationMin(r, 'assemble', n) + r.brakeTestMin) * MIN
  const leave = (car: CarState, reason: string) => {
    assignment[car.id] = null
    unassigned.push({ carId: car.id, reason })
  }
  let feederVersion = 0
  const spill = (car: CarState, fromTrain: string | null, reason: string) => {
    feederVersion++
    const serving = p.servedBy[car.blockId] ?? []
    const fromIdx = fromTrain ? serving.indexOf(fromTrain) : -1
    for (let i = fromIdx + 1; i < serving.length; i++) {
      const id = serving[i]
      if (annulled.has(id)) continue
      const run = runs[id]
      const slot = run.slots[run.def.blockSequence.indexOf(car.blockId)]
      if (slot.index < run.next || slot.activated) continue
      if ((p.carEarliest[car.id] ?? now) + carLeadMin(1) > run.def.departure) continue
      assignment[car.id] = id
      slot.cars.push(car)
      return
    }
    leave(car, reason)
  }

  for (const f of p.fixedAssemble) {
    const run = f.move.outboundId ? runs[f.move.outboundId] : undefined
    if (!run || annulled.has(run.def.id)) {
      droppedFixed.push({ key: f.move.key, lockId: f.lockId, reason: 'train annulled', pinned: f.pinned })
      continue
    }
    const idx = run.def.blockSequence.indexOf(f.move.blockId ?? '')
    if (idx < 0) {
      droppedFixed.push({ key: f.move.key, lockId: f.lockId, reason: 'block no longer on this train', pinned: f.pinned })
      continue
    }
    run.slots[idx].fixed.push(f)
    for (const id of f.move.carIds) assignment[id] = run.def.id
  }

  for (const g of p.groups) {
    const choice = c.groupTrain[g.key]
    for (const car of g.cars) {
      if (choice === undefined || choice === null) {
        leave(car, g.reachable.length ? 'left off by the planner: no room on a train that serves this block' : 'arrives too late for any train that serves this block')
        continue
      }
      const run = runs[choice]
      const slotIdx = run ? run.def.blockSequence.indexOf(car.blockId) : -1
      const late = run && (p.carEarliest[car.id] ?? now) + carLeadMin(1) > run.def.departure
      if (!run || slotIdx < 0 || annulled.has(choice) || slotIdx < run.next || late) {
        spill(car, run && slotIdx >= 0 ? choice : null, late ? 'arrives too late for any train that serves this block' : 'no remaining train serves this block')
        continue
      }
      assignment[car.id] = choice
      run.slots[slotIdx].cars.push(car)
    }
  }

  // ── Setouts: held cars coupled to a train come off first ───────────────
  for (const car of p.setouts) {
    const block = p.blocks[car.blockId]
    const options = [block?.standingTrackId, ...(block?.alternateTrackIds ?? [])].filter(Boolean) as string[]
    const start = Math.max(trimFree, lastStart)
    applyReleases(start)
    const to = options.find((id) => p.tracks[id]?.open && ft[id] + car.lengthFt <= p.tracks[id].capacityFt && otherBlockCount(id, car.blockId) === 0)
    if (!to) continue
    const end = start + r.setoutMin * MIN
    const from = car.trackId as string
    let setoutKey = `setout:${car.coupledTo}:${car.id}`
    for (let n = 2; p.usedKeys.has(setoutKey); n++) setoutKey = `setout:${car.coupledTo}:${car.id}#${n}`
    moves.push({
      key: setoutKey,
      kind: 'setout',
      crew: 'trim',
      carIds: [car.id],
      fromTrackId: from,
      toTrackId: to,
      blockId: car.blockId,
      inboundId: car.inboundId,
      outboundId: car.coupledTo,
      plannedStart: start,
      plannedEnd: end,
    })
    ft[to] += car.lengthFt
    onTrack[to][car.blockId] = (onTrack[to][car.blockId] ?? 0) + 1
    onTrackTotal[to] += 1
    addRelease({ t: end, track: from, ft: car.lengthFt, blockId: null, count: 0 })
    trimFree = end
    lastStart = start
    journal.length = 0
  }

  function otherBlockCount(trackId: string, blockId: string): number {
    return (onTrackTotal[trackId] ?? 0) - (onTrack[trackId]?.[blockId] ?? 0)
  }

  // ── Main loop ──────────────────────────────────────────────────────────
  const order = new Map(c.classifyOrder.map((key, i) => [key, i]))
  const cutQueue: Cut[] = [...p.cuts].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
    return (order.get(a.key) ?? 1e9) - (order.get(b.key) ?? 1e9)
  })
  const cutRetry: Record<string, { at: number; tries: number }> = {}
  const cutDone = new Set<string>()
  const trainOrder = c.trainOrder.filter((id) => runs[id] && !annulled.has(id))
  const receiveQueue = [...p.receives]
  const receiveRetry: Record<string, { at: number; tries: number }> = {}
  let gating = p.precedence.length > 0
  let pinnedTrim = [...p.pinnedTrim]

  const gated = (key: string): boolean => {
    if (!gating) return false
    for (const [before, after] of p.precedence) if (after === key && !scheduled.has(before) && mightExist(before)) return true
    return false
  }
  const mightExist = (key: string): boolean => {
    if (key.startsWith('classify:')) return p.cuts.some((cut) => cut.key === key && !cutDone.has(key))
    if (key.startsWith('assemble:')) {
      const [, train, block] = key.replace(/#\d+$/, '').split(':')
      const run = runs[train]
      const idx = run ? run.def.blockSequence.indexOf(block) : -1
      return idx >= run?.next
    }
    return false
  }

  const activate = (run: TrainRun, slot: Slot) => {
    if (slot.activated) return
    slot.activated = true
    const dep = run.def
    const fixedIds = new Set<string>()
    for (const f of slot.fixed) for (const id of f.move.carIds) fixedIds.add(id)
    const groups: Slot['groups'] = []
    for (const f of slot.fixed) {
      const list = f.move.carIds.map((id) => p.cars[id])
      if (!fitsInOrder(run, list, dep)) {
        noteDropped(f, 'train limits or hazmat placement')
        for (const car of list) spill(car, run.def.id, 'train limits or hazmat placement')
        continue
      }
      for (const car of list) recordOnTrain(run, car)
      groups.push({ trackId: carTrack[list[0].id] ?? f.move.fromTrackId ?? '', cars: list, fixed: f })
    }
    // Each source track is one pull, and the consist is the pulls in order. Within a pull,
    // non-placarded cars go first, and pulls with no placarded cars go ahead of pulls with
    // some, so a placarded car gets its buffer whenever one can exist.
    const byTrack = new Map<string, CarState[]>()
    for (const car of slot.cars) {
      if (carReady[car.id] === undefined) continue
      const track = carTrack[car.id] ?? car.trackId ?? ''
      if (!byTrack.has(track)) byTrack.set(track, [])
      byTrack.get(track)!.push(car)
    }
    const pulls = [...byTrack.entries()].sort(([a, x], [b, y]) => Number(x.some((c) => c.hazmatClass)) - Number(y.some((c) => c.hazmatClass)) || a.localeCompare(b))
    for (const [trackId, list] of pulls) {
      list.sort((a, b) => Number(Boolean(a.hazmatClass)) - Number(Boolean(b.hazmatClass)) || a.consistPos - b.consistPos || a.id.localeCompare(b.id))
      const placed: CarState[] = []
      for (const car of list) {
        if (!placeOk(run, car, dep)) {
          spill(car, run.def.id, overReason(run, car, dep))
          continue
        }
        recordOnTrain(run, car)
        placed.push(car)
      }
      if (placed.length > 0) groups.push({ trackId, cars: placed, fixed: null })
    }
    slot.groups = groups
  }

  const placeOk = (run: Counters & { depTrack: string | null }, car: CarState, dep: OutboundDef): boolean => {
    if (run.lengthFt + car.lengthFt > dep.maxLengthFt) return false
    if (run.tons + car.tons > dep.maxTons) return false
    if (car.hazmatClass) {
      if (!run.sawHaz && run.beforeHaz < r.hazmatBufferCars) return false
      if (run.lastClass && incompatible(run.lastClass, car.hazmatClass)) return false
    }
    if (run.depTrack && p.tracks[run.depTrack] && run.lengthFt + car.lengthFt > p.tracks[run.depTrack].capacityFt) return false
    return true
  }
  /** Checks a fixed move's cars in their order, each behind the ones before it. */
  const fitsInOrder = (run: TrainRun, cars: CarState[], dep: OutboundDef): boolean => {
    const trial = { lengthFt: run.lengthFt, tons: run.tons, count: run.count, beforeHaz: run.beforeHaz, sawHaz: run.sawHaz, lastClass: run.lastClass, depTrack: run.depTrack }
    for (const car of cars) {
      if (!placeOk(trial, car, dep)) return false
      recordOnTrain(trial, car)
    }
    return true
  }
  /** A fixed move that can't stay. It must also stop holding the trim crew's place in line. */
  const noteDropped = (f: FixedAssemble, reason: string) => {
    droppedFixed.push({ key: f.move.key, lockId: f.lockId, reason, pinned: f.pinned })
    pinnedTrim = pinnedTrim.filter((key) => key !== f.move.key)
  }
  const overReason = (run: TrainRun, car: CarState, dep: OutboundDef): string => {
    if (run.lengthFt + car.lengthFt > dep.maxLengthFt) return 'train length limit'
    if (run.tons + car.tons > dep.maxTons) return 'train tonnage limit'
    if (car.hazmatClass) return 'hazmat placement (simplified rule)'
    return 'departure track capacity'
  }
  const incompatible = (a: string, b: string) => r.hazmatIncompatible.some(([x, y]) => (x === a && y === b) || (x === b && y === a))

  /** Next unfinished slot, skipping ones with nothing to move. */
  const nextSlot = (run: TrainRun): Slot | null => {
    for (let i = run.next; i < run.slots.length; i++) {
      const slot = run.slots[i]
      if (slot.activated && slot.groups.length === 0) continue
      if (!slot.activated && slot.cars.length === 0 && slot.fixed.length === 0) continue
      return slot
    }
    return null
  }
  const refreshSlot = (slot: Slot) => {
    if (slot.cacheVersion === feederVersion) return
    slot.cacheVersion = feederVersion
    let known = true
    let ready = 0
    for (const car of slot.cars) {
      const at = carReady[car.id]
      if (at === INF) {
        if (!cutDropped.has(car.id)) known = false
      } else if ((at ?? now) > ready) ready = at ?? now
    }
    for (const f of slot.fixed) {
      for (const id of f.move.carIds) {
        const at = carReady[id]
        if (at === INF) {
          if (!cutDropped.has(id)) known = false
        } else if ((at ?? now) > ready) ready = at ?? now
      }
    }
    slot.cacheKnown = known
    slot.cacheReady = ready
  }
  const slotFeederKnown = (slot: Slot): boolean => {
    if (slot.activated) return true
    refreshSlot(slot)
    return slot.cacheKnown
  }
  const cutDropped = new Set<string>()

  const windowStart = (run: TrainRun) => run.def.departure - r.assembleWindowMin * MIN

  let guard = 0
  const maxSteps = 20 * (p.cuts.length + p.receives.length + p.trains.length * 4 + p.fixedAssemble.length) + 200
  while (guard++ < maxSteps) {
    // Road crew: the next train to arrive.
    let roadEst = INF
    const nextReceive = receiveQueue[0]
    if (nextReceive) roadEst = Math.max(nextReceive.eta, now, lastStart, receiveRetry[nextReceive.id]?.at ?? 0)

    // Hump crew: first cut in order that can start soonest.
    let humpCut: Cut | null = null
    let humpEst = INF
    for (const cut of cutQueue) {
      if (cutDone.has(cut.key)) continue
      const ready = inboundReady[cut.inboundId] ?? now
      if (ready === INF) {
        if (cut.pinned) break
        continue
      }
      if (gated(cut.key)) continue
      const est = Math.max(humpFree, lastStart, ready, cutRetry[cut.key]?.at ?? 0)
      if (est < humpEst) {
        humpEst = est
        humpCut = cut
      }
      if (cut.pinned) break
    }

    // Trim crew: the train whose next slot can start soonest.
    let trimRun: TrainRun | null = null
    let trimSlot: Slot | null = null
    let trimEst = INF
    for (const id of trainOrder) {
      const run = runs[id]
      const slot = nextSlot(run)
      if (!slot || !slotFeederKnown(slot)) continue
      const key = slotBaseKey(run, slot)
      if (gated(key)) continue
      if (pinnedTrim.length > 0) {
        const head = pinnedTrim[0]
        const isHead = slot.fixed.some((f) => f.move.key === head) || (slot.activated && slot.groups[0]?.fixed?.move.key === head)
        if (!isHead && !slot.activated) continue
      }
      let carsReady = 0
      if (!slot.activated) {
        carsReady = slot.cacheReady
      } else {
        for (const car of slot.groups[0].cars) carsReady = Math.max(carsReady, carReady[car.id] ?? now)
      }
      const fixedPin = slot.fixed.some((f) => f.pinned)
      const est = Math.max(trimFree, lastStart, fixedPin ? now : windowStart(run), run.retryAt, Math.min(carsReady, run.def.departure))
      if (est < trimEst) {
        trimEst = est
        trimRun = run
        trimSlot = slot
      }
    }

    if (roadEst === INF && humpEst === INF && trimEst === INF) {
      if (gating) {
        gating = false
        continue
      }
      if (pinnedTrim.length > 0) {
        for (const key of pinnedTrim) {
          const f = p.fixedAssemble.find((x) => x.move.key === key)
          droppedFixed.push({ key, lockId: f?.lockId ?? null, reason: 'could not keep its place', pinned: true })
        }
        pinnedTrim = []
        continue
      }
      break
    }

    const before = moves.length
    if (roadEst <= humpEst && roadEst <= trimEst) {
      scheduleReceive(nextReceive, roadEst)
    } else if (humpEst <= trimEst && humpCut) {
      scheduleCut(humpCut, humpEst)
    } else if (trimRun && trimSlot) {
      scheduleTrim(trimRun, trimSlot, trimEst)
    }
    if (moves.length > before) journal.length = 0
    else undoReleases()
  }

  function slotBaseKey(run: TrainRun, slot: Slot): string {
    return `assemble:${run.def.id}:${slot.blockId}`
  }

  function scheduleReceive(inbound: Problem['receives'][number], est: number) {
    applyReleases(est)
    const allCars = p.inboundCars[inbound.id] ?? []
    const length = allCars.reduce((sum, car) => sum + car.lengthFt, 0)
    const prior = p.baseline?.find((m) => m.key === `receive:${inbound.id}`)?.toTrackId ?? null
    const options = [...p.receivingTrackIds]
    if (prior && options.includes(prior)) {
      options.splice(options.indexOf(prior), 1)
      options.unshift(prior)
    }
    const track = options.find((id) => ft[id] + length <= p.tracks[id].capacityFt)
    if (!track) {
      const retry = (receiveRetry[inbound.id] ??= { at: est, tries: 0 })
      retry.tries++
      const next = nextReleaseOn((id) => p.tracks[id]?.kind === 'receiving')
      if (retry.tries > 24) {
        receiveQueue.shift()
        for (const car of allCars) {
          cutDropped.add(car.id)
          removeFromSlots(car)
          leave(car, 'no receiving track had room')
        }
        for (const cut of p.cuts) if (cut.inboundId === inbound.id) cutDone.add(cut.key)
        return
      }
      retry.at = next !== INF ? Math.max(next, est + MIN) : est + 15 * MIN
      return
    }
    receiveQueue.shift()
    const end = est + r.receiveMin * MIN
    moves.push({
      key: `receive:${inbound.id}`,
      kind: 'receive',
      crew: 'road',
      carIds: allCars.map((car) => car.id),
      fromTrackId: null,
      toTrackId: track,
      blockId: null,
      inboundId: inbound.id,
      outboundId: null,
      plannedStart: est,
      plannedEnd: end,
    })
    ft[track] += length
    inboundTrack[inbound.id] = track
    inboundReady[inbound.id] = end + r.inspectMin * MIN
    for (const car of allCars) carTrack[car.id] = track
    lastStart = est
    scheduled.add(`receive:${inbound.id}`)
  }

  function removeFromSlots(car: CarState) {
    feederVersion++
    const trainId = assignment[car.id]
    if (!trainId) return
    const run = runs[trainId]
    if (!run) return
    const slot = run.slots[run.def.blockSequence.indexOf(car.blockId)]
    if (slot) slot.cars = slot.cars.filter((x) => x.id !== car.id)
  }

  function allowedTracks(cut: Cut): string[] {
    if (cut.fixedTrack) return p.tracks[cut.fixedTrack]?.open ? [cut.fixedTrack] : []
    const block = p.blocks[cut.blockId]
    const pref = c.cutTrack[cut.key]
    const list = [pref, block?.standingTrackId, ...(block?.alternateTrackIds ?? [])].filter((id): id is string => Boolean(id) && Boolean(p.tracks[id]?.open))
    return [...new Set(list)]
  }

  function scheduleCut(cut: Cut, est: number) {
    applyReleases(est)
    const tracks = allowedTracks(cut)
    const usable = tracks.filter((id) => otherBlockCount(id, cut.blockId) === 0)
    const total = cut.cars.reduce((sum, car) => sum + car.lengthFt, 0)
    const whole = usable.find((id) => ft[id] + total <= p.tracks[id].capacityFt)
    const pieces: { track: string; cars: CarState[] }[] = []
    if (whole) pieces.push({ track: whole, cars: cut.cars })
    else if (!cut.fixedTrack) {
      let rest = [...cut.cars]
      for (const id of usable) {
        let room = p.tracks[id].capacityFt - ft[id]
        const take: CarState[] = []
        const keep: CarState[] = []
        for (const car of rest) {
          if (car.lengthFt <= room) {
            take.push(car)
            room -= car.lengthFt
          } else keep.push(car)
        }
        if (take.length) pieces.push({ track: id, cars: take })
        rest = keep
        if (rest.length === 0) break
      }
      if (rest.length > 0) {
        // Not enough room right now. Wait for a pull, then try again, then give up on these cars.
        const retry = (cutRetry[cut.key] ??= { at: est, tries: 0 })
        retry.tries++
        const next = nextReleaseOn((id) => tracks.includes(id))
        if (retry.tries <= 12) {
          retry.at = next !== INF ? Math.max(next, est + MIN) : est + 20 * MIN
          return
        }
        for (const car of rest) {
          cutDropped.add(car.id)
          removeFromSlots(car)
          leave(car, 'no room on any track allowed for this block')
        }
      }
    } else {
      const retry = (cutRetry[cut.key] ??= { at: est, tries: 0 })
      retry.tries++
      const next = nextReleaseOn((id) => tracks.includes(id))
      if (tracks.length > 0 && retry.tries <= 12) {
        retry.at = next !== INF ? Math.max(next, est + MIN) : est + 20 * MIN
        return
      }
      if (cut.lockId || cut.pinned) droppedFixed.push({ key: cut.key, lockId: cut.lockId, reason: tracks.length ? 'no room on its fixed track' : 'its fixed track is blocked', pinned: cut.pinned })
      for (const car of cut.cars) {
        cutDropped.add(car.id)
        removeFromSlots(car)
        leave(car, 'no room on the fixed track')
      }
    }
    cutDone.add(cut.key)
    scheduled.add(cut.key)
    feederVersion++
    let start = est
    pieces.forEach((piece, i) => {
      const dur = moveDurationMin(r, 'classify', piece.cars.length) * MIN
      const end = start + dur
      let key = cut.key
      if (i > 0) {
        let n = i + 1
        key = `${cut.key}#${n}`
        while (p.usedKeys.has(key) || scheduled.has(key)) key = `${cut.key}#${++n}`
      }
      const from = inboundTrack[cut.inboundId] ?? piece.cars[0].trackId
      moves.push({
        key,
        kind: 'classify',
        crew: 'hump',
        carIds: piece.cars.map((car) => car.id),
        fromTrackId: from,
        toTrackId: piece.track,
        blockId: cut.blockId,
        inboundId: cut.inboundId,
        outboundId: null,
        plannedStart: start,
        plannedEnd: end,
      })
      scheduled.add(key)
      const length = piece.cars.reduce((sum, car) => sum + car.lengthFt, 0)
      ft[piece.track] += length
      onTrack[piece.track][cut.blockId] = (onTrack[piece.track][cut.blockId] ?? 0) + piece.cars.length
      onTrackTotal[piece.track] += piece.cars.length
      if (from) addRelease({ t: end, track: from, ft: length, blockId: null, count: 0 })
      for (const car of piece.cars) {
        carReady[car.id] = end
        carTrack[car.id] = piece.track
      }
      lastStart = start
      humpFree = end
      start = end
    })
  }

  /** A pull fell through. Its cars move on, and the rest of the slot is re-checked without them. */
  function dropGroup(run: TrainRun, slot: Slot, group: Slot['groups'][number], reason: string) {
    slot.groups.shift()
    if (group.fixed) noteDropped(group.fixed, reason)
    for (const car of group.cars) {
      if (cutDropped.has(car.id) || carReady[car.id] === INF) leave(car, 'its classify move could not be scheduled')
      else spill(car, run.def.id, reason)
    }
    rewalk(run, slot)
  }

  function rewalk(run: TrainRun, slot: Slot) {
    Object.assign(run, run.committed)
    const remaining = slot.groups
    slot.groups = []
    for (const g of remaining) {
      if (g.fixed) {
        if (fitsInOrder(run, g.cars, run.def)) {
          for (const car of g.cars) recordOnTrain(run, car)
          slot.groups.push(g)
        } else {
          noteDropped(g.fixed, 'train limits or hazmat placement')
          for (const car of g.cars) spill(car, run.def.id, 'train limits or hazmat placement')
        }
        continue
      }
      const kept: CarState[] = []
      for (const car of g.cars) {
        if (placeOk(run, car, run.def)) {
          recordOnTrain(run, car)
          kept.push(car)
        } else spill(car, run.def.id, overReason(run, car, run.def))
      }
      if (kept.length > 0) slot.groups.push({ ...g, cars: kept })
    }
  }

  function scheduleTrim(run: TrainRun, slot: Slot, est: number) {
    activate(run, slot)
    if (slot.groups.length === 0) {
      run.next = Math.max(run.next, slot.index)
      return
    }
    applyReleases(est)
    // The train takes one departure track, and holds it from its first real move until it leaves.
    let track = run.depTrack
    if (!track) {
      const pref = c.departureTrack[run.def.id]
      const options = [pref, ...p.departureTrackIds].filter((id): id is string => Boolean(id) && Boolean(p.tracks[id]?.open))
      const free = options.find((id) => ft[id] === 0)
      if (!free) {
        const next = nextReleaseOn((id) => p.tracks[id]?.kind === 'departure')
        if (next === INF || next + (moveDurationMin(r, 'assemble', 1) + r.brakeTestMin) * MIN > run.def.departure) {
          while (slot.groups.length > 0) dropGroup(run, slot, slot.groups[0], 'no free departure track')
          return
        }
        run.retryAt = Math.max(next, est + MIN)
        return
      }
      track = free
    }
    const group = slot.groups[0]
    let carsReady = 0
    for (const car of group.cars) carsReady = Math.max(carsReady, carReady[car.id] ?? now)
    if (carsReady === INF) {
      dropGroup(run, slot, group, 'its classify move could not be scheduled')
      return
    }
    const start = Math.max(est, carsReady)
    const dur = moveDurationMin(r, 'assemble', group.cars.length) * MIN
    const end = start + dur
    if (end + r.brakeTestMin * MIN > run.def.departure) {
      dropGroup(run, slot, group, 'cannot be coupled before departure')
      return
    }
    const length = group.cars.reduce((sum, car) => sum + car.lengthFt, 0)
    if (ft[track] + length > p.tracks[track].capacityFt) {
      dropGroup(run, slot, group, 'no room on the departure track')
      return
    }
    const base = slotBaseKey(run, slot)
    let key = group.fixed?.move.key ?? ''
    if (!key) {
      let seq = (run.moveSeq[slot.blockId] ?? 0) + 1
      key = seq === 1 ? base : `${base}#${seq}`
      while (p.usedKeys.has(key) || scheduled.has(key)) {
        seq++
        key = `${base}#${seq}`
      }
      run.moveSeq[slot.blockId] = seq
    }
    const fromTrack = carTrack[group.cars[0].id] ?? group.trackId
    moves.push({
      key,
      kind: 'assemble',
      crew: 'trim',
      carIds: group.cars.map((car) => car.id),
      fromTrackId: fromTrack,
      toTrackId: track,
      blockId: slot.blockId,
      inboundId: null,
      outboundId: run.def.id,
      plannedStart: start,
      plannedEnd: end,
    })
    if (pinnedTrim[0] === key) pinnedTrim = pinnedTrim.slice(1)
    scheduled.add(key)
    scheduled.add(base)
    run.depTrack = track
    ft[track] += length
    addRelease({ t: end, track: fromTrack, ft: length, blockId: slot.blockId, count: group.cars.length })
    addRelease({ t: run.def.departure, track, ft: length, blockId: null, count: 0 })
    for (const car of group.cars) {
      carTrack[car.id] = track
      recordOnTrain(run.committed, car)
    }
    lastStart = start
    trimFree = end
    run.readyAt = end + r.brakeTestMin * MIN
    slot.groups.shift()
    run.next = Math.max(run.next, slot.index)
  }

  // Anything still unscheduled when the loop ends has nowhere to go.
  for (const cut of p.cuts) {
    if (cutDone.has(cut.key)) continue
    if (cut.lockId || cut.pinned) droppedFixed.push({ key: cut.key, lockId: cut.lockId, reason: 'could not be scheduled', pinned: cut.pinned })
    for (const car of cut.cars) {
      removeFromSlots(car)
      if (assignment[car.id] !== null) leave(car, 'could not be classified in this shift')
    }
  }
  for (const run of Object.values(runs)) {
    for (let i = 0; i < run.slots.length; i++) {
      const slot = run.slots[i]
      if (!slot.activated) {
        for (const f of slot.fixed) if (!scheduled.has(f.move.key)) droppedFixed.push({ key: f.move.key, lockId: f.lockId, reason: 'could not be scheduled', pinned: f.pinned })
        for (const car of slot.cars) if (assignment[car.id] === run.def.id) leave(car, 'not coupled in time')
      } else {
        for (const g of slot.groups) {
          if (g.fixed && !scheduled.has(g.fixed.move.key)) droppedFixed.push({ key: g.fixed.move.key, lockId: g.fixed.lockId, reason: 'could not be scheduled', pinned: g.fixed.pinned })
          for (const car of g.cars) leave(car, 'not coupled in time')
        }
      }
    }
  }
  // Cars that were left unassigned may have been spilled more than once; the last word counts.
  const finalUnassigned = new Map<string, string>()
  for (const u of unassigned) if (assignment[u.carId] === null || assignment[u.carId] === undefined) finalUnassigned.set(u.carId, u.reason)

  // ── Outcome and objective ──────────────────────────────────────────────
  const trains: Record<string, TrainOutcome> = {}
  let dwellHours = 0
  const carsOnTrain: Record<string, number> = {}
  for (const [carId, trainId] of Object.entries(assignment)) {
    if (!trainId) continue
    carsOnTrain[trainId] = (carsOnTrain[trainId] ?? 0) + 1
    dwellHours += Math.max(0, runs[trainId].def.departure - p.carArrival[carId]) / 3_600_000
  }
  const annulledList: string[] = []
  for (const t of p.trains) {
    const run = runs[t.id]
    const done = run.committed
    const isAnnulled = annulled.has(t.id) || done.count <= 0
    if (isAnnulled) annulledList.push(t.id)
    trains[t.id] = { id: t.id, cars: done.count, lengthFt: done.lengthFt, tons: done.tons, readyAt: run.readyAt, annulled: isAnnulled, coupled: p.coupled[t.id]?.length ?? 0 }
  }
  let alternateCuts = 0
  for (const m of moves) {
    if (m.kind !== 'classify' || !m.blockId) continue
    if (m.toTrackId !== p.blocks[m.blockId]?.standingTrackId) alternateCuts++
  }
  const allMoves = [...p.frozen, ...moves]
  let changes: MoveDiffCounts | null = null
  if (p.stable && p.baseline) changes = countDisturbed(p.baseline, allMoves, p.frozenKeys)
  const breakdown: CostBreakdown = {
    total: 0,
    annulledTrains: annulledList.length,
    unassignedCars: finalUnassigned.size,
    dwellCarHours: Math.round(dwellHours * 10) / 10,
    moves: moves.length,
    alternateCuts,
    changedMoves: changes?.disturbed ?? 0,
  }
  breakdown.total =
    breakdown.annulledTrains * WEIGHTS.annulledTrain +
    breakdown.unassignedCars * WEIGHTS.unassignedCar +
    dwellHours * WEIGHTS.dwellPerCarHour +
    breakdown.moves * WEIGHTS.move +
    breakdown.alternateCuts * WEIGHTS.alternateCut +
    breakdown.changedMoves * WEIGHTS.changedMove

  return {
    moves,
    allMoves,
    assignment,
    unassigned: [...finalUnassigned.entries()].map(([carId, reason]) => ({ carId, reason })),
    trains,
    annulled: annulledList,
    cost: breakdown,
    changes,
    droppedFixed,
  }
}

/**
 * Decode, annulling any train that can't reach its minimum car count and
 * decoding again so its cars roll instead of being moved for nothing.
 */
export function decode(p: Problem, c: Candidate): Decoded {
  const annulled = new Set<string>()
  let result = decodeOnce(p, c, annulled)
  for (let pass = 0; pass < p.trains.length; pass++) {
    const under = p.trains.find((t) => {
      const outcome = result.trains[t.id]
      return !annulled.has(t.id) && outcome.cars > 0 && outcome.coupled === 0 && outcome.cars < t.minCars
    })
    if (!under) break
    annulled.add(under.id)
    result = decodeOnce(p, c, annulled)
  }
  return result
}
