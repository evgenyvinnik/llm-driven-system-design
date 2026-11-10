/**
 * The constructive heuristic: earliest-deadline-first. Each group goes on the
 * earliest train it can make and that still has room, each cut prefers its
 * standing track, and the hump crew works cuts in order of the deadline they
 * feed. No search, no look-ahead. Also the starting point for local search.
 * @module planner/greedy
 */
import type { Candidate } from './decode.js'
import type { Problem } from './problem.js'

export function greedyCandidate(p: Problem): Candidate {
  const load: Record<string, { ft: number; tons: number }> = {}
  for (const t of p.trains) {
    load[t.id] = { ft: 0, tons: 0 }
    for (const car of p.coupled[t.id] ?? []) {
      load[t.id].ft += car.lengthFt
      load[t.id].tons += car.tons
    }
  }
  for (const f of p.fixedAssemble) {
    const id = f.move.outboundId as string
    for (const carId of f.move.carIds) {
      const car = p.cars[carId]
      if (!car || !load[id]) continue
      load[id].ft += car.lengthFt
      load[id].tons += car.tons
    }
  }
  const groupTrain: Record<string, string | null> = {}
  const groupDeadline: Record<string, number> = {}
  const ordered = [...p.groups].sort((a, b) => a.earliest - b.earliest || a.key.localeCompare(b.key))
  for (const g of ordered) {
    const feet = g.cars.reduce((s, c) => s + c.lengthFt, 0)
    const tons = g.cars.reduce((s, c) => s + c.tons, 0)
    const reachable = g.reachable
    const fits = reachable.find((id) => load[id].ft + feet <= p.trainById[id].maxLengthFt && load[id].tons + tons <= p.trainById[id].maxTons)
    const choice = fits ?? reachable[0] ?? null
    groupTrain[g.key] = choice
    if (choice) {
      load[choice].ft += feet
      load[choice].tons += tons
      groupDeadline[g.key] = p.trainById[choice].departure
    }
  }
  const cutTrack: Record<string, string> = {}
  for (const cut of p.cuts) cutTrack[cut.key] = cut.fixedTrack ?? p.blocks[cut.blockId]?.standingTrackId ?? ''
  const deadline = (groupKey: string) => groupDeadline[groupKey] ?? Number.MAX_SAFE_INTEGER
  const classifyOrder = [...p.cuts]
    .filter((c) => !c.pinned)
    .sort((a, b) => deadline(a.groupKey) - deadline(b.groupKey) || (p.carEarliest[a.cars[0]?.id] ?? 0) - (p.carEarliest[b.cars[0]?.id] ?? 0) || a.key.localeCompare(b.key))
    .map((c) => c.key)
  const trainOrder = p.trains.map((t) => t.id)
  const departureTracks = p.snap.tracks.filter((t) => t.kind === 'departure' && t.open).map((t) => t.id)
  const departureTrack: Record<string, string> = {}
  p.trains.forEach((t, i) => {
    if (departureTracks.length) departureTrack[t.id] = departureTracks[i % departureTracks.length]
  })
  return { groupTrain, cutTrack, classifyOrder, trainOrder, departureTrack }
}

/** Starting point for a stable replan: what the previous plan decided, wherever it still applies. */
export function baselineCandidate(p: Problem, fallback: Candidate): Candidate {
  const baseline = p.baseline
  if (!baseline) return fallback
  const rank = new Map(baseline.map((m, i) => [m.key, i]))
  const carTrain: Record<string, string> = {}
  const trainFirst: Record<string, number> = {}
  const departureTrack = { ...fallback.departureTrack }
  baseline.forEach((m, i) => {
    if (m.kind === 'assemble' && m.outboundId) {
      for (const id of m.carIds) carTrain[id] = m.outboundId
      trainFirst[m.outboundId] ??= i
      departureTrack[m.outboundId] = m.toTrackId
    }
  })
  const groupTrain = { ...fallback.groupTrain }
  for (const g of p.groups) {
    const votes: Record<string, number> = {}
    for (const car of g.cars) {
      const id = carTrain[car.id]
      if (id && p.trainById[id]) votes[id] = (votes[id] ?? 0) + 1
    }
    const best = Object.entries(votes).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]
    if (best) groupTrain[g.key] = best[0]
  }
  const cutTrack = { ...fallback.cutTrack }
  for (const cut of p.cuts) {
    if (cut.fixedTrack) continue
    const prior = baseline.find((m) => m.key === cut.key)
    if (prior && p.tracks[prior.toTrackId]?.open) cutTrack[cut.key] = prior.toTrackId
  }
  const fallbackRank = new Map(fallback.classifyOrder.map((k, i) => [k, i]))
  const classifyOrder = [...fallback.classifyOrder].sort((a, b) => (rank.get(a) ?? 1e6 + (fallbackRank.get(a) ?? 0)) - (rank.get(b) ?? 1e6 + (fallbackRank.get(b) ?? 0)))
  const trainOrder = [...fallback.trainOrder].sort((a, b) => (trainFirst[a] ?? 1e6) - (trainFirst[b] ?? 1e6) || fallback.trainOrder.indexOf(a) - fallback.trainOrder.indexOf(b))
  return { groupTrain, cutTrack, classifyOrder, trainOrder, departureTrack }
}
