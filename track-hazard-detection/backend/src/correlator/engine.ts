/**
 * The correlation engine (complex event processing). It turns evidence into
 * hazard events, against a `CorrelatorStore` that is PostgreSQL in production
 * (inside the consumer's transaction) and an in-memory map in tests.
 *
 * For each new piece of evidence:
 *  1. A ground-vibration spike that a train explains (a train was within
 *     `trainExplainMiles` at the spike's event time) is stored and ignored.
 *  2. If an open hazard of a compatible kind covers it (within the radius of the
 *     hazard's span, not much older than the hazard), it joins that hazard:
 *     HazardEvidenceAdded, plus HazardUpgraded if severity rose. Many sensors
 *     seeing one rockfall give one hazard with many evidence rows.
 *  3. Otherwise it is clustered with unattached, compatible evidence inside the
 *     space-time window (+-30 s, +-0.5 mi of event time). If the cluster's
 *     combined confidence reaches the detect threshold: HazardDetected.
 *  4. Otherwise it waits as a candidate; later evidence (even late evidence)
 *     can still complete the cluster.
 *
 * A train position can retroactively explain spikes (a late PTC report):
 * the affected hazard loses that evidence and is downgraded. Hazards are never
 * closed automatically; a person clears them or marks them a false alarm.
 * @module correlator/engine
 */
import type { DomainEventDraft, Severity } from '../shared/events/domain.js'
import { draft, severityRank } from '../shared/events/domain.js'
import { BAND_RANK, assessHeat, type HeatConfig, type Sample } from './heat.js'
import {
  canAttach,
  classify,
  combinedConfidence,
  compatible,
  distanceToSpan,
  hazardKindFor,
  inWindow,
  round3,
  statusRank,
  supports,
  toRef,
  trainMilepostAt,
  type CorrelationConfig,
  type Evidence,
  type HazardRecord,
  type TrainFix,
} from './rules.js'

export interface Trigger {
  eventId: string
  occurredAt: string
  recordedAt: string
  lane: string
  late: boolean
  correlationId: string
}

export interface CorrelatorStore {
  nearbyEvidence(subdivisionId: string, mpFrom: number, mpTo: number, fromIso: string, toIso: string): Promise<Evidence[]>
  openHazardsNear(subdivisionId: string, mpFrom: number, mpTo: number): Promise<HazardRecord[]>
  hazardEvidence(hazardId: string): Promise<Evidence[]>
  hazardRecord(hazardId: string): Promise<HazardRecord | null>
  saveEvidence(e: Evidence): Promise<void>
  updateEvidence(eventIds: string[], patch: { hazardId?: string | null; explainedByTrain?: string | null }): Promise<void>
  saveHazard(h: HazardRecord): Promise<void>
  newHazard(): Promise<{ hazardId: string; code: string }>
  /** Appends to `hazard-<id>` at h.streamVersion and returns the new version. */
  appendHazard(h: HazardRecord, drafts: DomainEventDraft[], trigger: Trigger): Promise<number>
  trainFixesAround(subdivisionId: string, atIso: string): Promise<Array<{ before: TrainFix | null; after: TrainFix | null }>>
  trainFixesAdjacent(trainId: string, atIso: string): Promise<{ before: TrainFix | null; after: TrainFix | null }>
  unexplainedVibration(subdivisionId: string, mpFrom: number, mpTo: number, fromIso: string, toIso: string): Promise<Evidence[]>
  railTempSamples(sensorId: string, sinceIso: string): Promise<Sample[]>
  addRailTempSample(sensorId: string, s: Sample): Promise<void>
  heatState(segmentId: string): Promise<{ band: string; hazardId: string | null } | null>
  setHeatState(segmentId: string, band: string, hazardId: string | null): Promise<void>
  /** Folded state of a hazard stream, to check that it is still open and get its version. */
  hazardStreamState(hazardId: string): Promise<{ open: boolean; version: number } | null>
}

export interface Outcome {
  kind: 'explained' | 'attached' | 'detected' | 'candidate' | 'none'
  hazardId?: string
  events: string[]
}

const sevUp = (a: Severity, b: Severity) => severityRank(b) > severityRank(a)

/** Steps 1-4 above for one piece of evidence. */
export async function correlateEvidence(store: CorrelatorStore, ev: Evidence, trigger: Trigger, cfg: CorrelationConfig): Promise<Outcome> {
  if (ev.kind === 'ground_vibration') {
    const train = await explainingTrain(store, ev, cfg)
    if (train) {
      await store.saveEvidence({ ...ev, explainedByTrain: train })
      return { kind: 'explained', events: [] }
    }
  }
  await store.saveEvidence(ev)

  // 2. Join an open hazard that covers this evidence.
  const open = (await store.openHazardsNear(ev.subdivisionId, ev.milepost - cfg.radiusMiles, ev.milepost + cfg.radiusMiles)).filter((h) => canAttach(h, ev, cfg))
  open.sort((a, b) => distanceToSpan(a, ev.milepost) - distanceToSpan(b, ev.milepost) || a.firstEvidenceAt.localeCompare(b.firstEvidenceAt))
  for (const target of open) {
    const state = await store.hazardStreamState(target.hazardId)
    if (!state?.open) continue // closed by a person since the index was written
    target.streamVersion = state.version
    return attach(store, target, ev, trigger, cfg)
  }

  // 3. Cluster with unattached evidence inside the window.
  const from = new Date(Date.parse(ev.occurredAt) - cfg.windowSeconds * 1000).toISOString()
  const to = new Date(Date.parse(ev.occurredAt) + cfg.windowSeconds * 1000).toISOString()
  const nearby = (await store.nearbyEvidence(ev.subdivisionId, ev.milepost - cfg.radiusMiles, ev.milepost + cfg.radiusMiles, from, to)).filter(
    (e) => e.eventId !== ev.eventId && !e.hazardId && !e.explainedByTrain && compatible(e.kind, ev.kind) && inWindow(ev, e, cfg),
  )
  const kind = hazardKindFor([ev, ...nearby])
  if (!kind) return { kind: 'none', events: [] }
  const cluster = [ev, ...nearby.filter((e) => supports(kind, e.kind))]
  const confidence = combinedConfidence(cluster)
  if (confidence < cfg.detectThreshold) return { kind: 'candidate', events: [] }

  const { hazardId, code } = await store.newHazard()
  const cls = classify(confidence, cfg)
  const mps = cluster.map((e) => e.milepost)
  // The segment of the strongest evidence owns the hazard (its partition key); ties broken by sensor id for determinism.
  const anchor = [...cluster].sort((a, b) => b.confidence - a.confidence || a.sensorId.localeCompare(b.sensorId))[0]
  const h: HazardRecord = {
    hazardId,
    code,
    kind,
    subdivisionId: ev.subdivisionId,
    segmentId: anchor.segmentId,
    mpFrom: Math.min(...mps),
    mpTo: Math.max(...mps),
    confidence,
    severity: cls.severity,
    detectionStatus: cls.detectionStatus,
    firstEvidenceAt: cluster.map((e) => e.occurredAt).sort()[0],
    streamVersion: 0,
  }
  const event = draft('HazardDetected', {
    hazardId,
    code,
    kind,
    subdivisionId: h.subdivisionId,
    segmentId: h.segmentId,
    mpFrom: h.mpFrom,
    mpTo: h.mpTo,
    confidence,
    severity: cls.severity,
    detectionStatus: cls.detectionStatus,
    evidence: cluster.map(toRef),
    late: trigger.late,
    trigger: { eventId: trigger.eventId, occurredAt: trigger.occurredAt, recordedAt: trigger.recordedAt, lane: trigger.lane, late: trigger.late },
  })
  h.streamVersion = await store.appendHazard(h, [event], trigger)
  await store.updateEvidence(
    cluster.map((e) => e.eventId),
    { hazardId },
  )
  await store.saveHazard(h)
  return { kind: 'detected', hazardId, events: ['HazardDetected'] }
}

async function attach(store: CorrelatorStore, h: HazardRecord, ev: Evidence, trigger: Trigger, cfg: CorrelationConfig): Promise<Outcome> {
  const existing = await store.hazardEvidence(h.hazardId)
  if (existing.some((e) => e.eventId === ev.eventId)) return { kind: 'attached', hazardId: h.hazardId, events: [] }
  const all = [...existing, ev]
  const confidence = combinedConfidence(all)
  const cls = classify(confidence, cfg)
  const mpFrom = Math.min(h.mpFrom, ev.milepost)
  const mpTo = Math.max(h.mpTo, ev.milepost)
  if (confidence === h.confidence && mpFrom === h.mpFrom && mpTo === h.mpTo) {
    // Corroboration that changes nothing (the same sensor again, a second wire on one fence): keep the evidence row, append no event.
    await store.updateEvidence([ev.eventId], { hazardId: h.hazardId })
    return { kind: 'attached', hazardId: h.hazardId, events: [] }
  }
  const drafts: DomainEventDraft[] = [draft('HazardEvidenceAdded', { hazardId: h.hazardId, evidence: toRef(ev), confidence, mpFrom, mpTo })]
  const names = ['HazardEvidenceAdded']
  if (sevUp(h.severity, cls.severity) || statusRank(cls.detectionStatus) > statusRank(h.detectionStatus)) {
    drafts.push(
      draft('HazardUpgraded', {
        hazardId: h.hazardId,
        fromSeverity: h.severity,
        toSeverity: cls.severity,
        fromStatus: h.detectionStatus,
        toStatus: cls.detectionStatus,
        confidence,
        reason: `${ev.kind.replace('_', ' ')} at MP ${ev.milepost.toFixed(1)} (${ev.sensorId})${ev.late ? ', delivered late' : ''} raised confidence to ${confidence.toFixed(2)}`,
        late: ev.late,
      }),
    )
    names.push('HazardUpgraded')
    h.severity = cls.severity
    h.detectionStatus = cls.detectionStatus
  }
  h.confidence = confidence
  h.mpFrom = mpFrom
  h.mpTo = mpTo
  if (ev.occurredAt < h.firstEvidenceAt) h.firstEvidenceAt = ev.occurredAt
  h.streamVersion = await store.appendHazard(h, drafts, trigger)
  await store.updateEvidence([ev.eventId], { hazardId: h.hazardId })
  await store.saveHazard(h)
  return { kind: 'attached', hazardId: h.hazardId, events: names }
}

async function explainingTrain(store: CorrelatorStore, ev: Evidence, cfg: CorrelationConfig): Promise<string | null> {
  const fixes = await store.trainFixesAround(ev.subdivisionId, ev.occurredAt)
  for (const { before, after } of fixes) {
    const mp = trainMilepostAt(before, after, ev.occurredAt, cfg.trainExtrapolateSeconds)
    if (mp !== null && Math.abs(mp - ev.milepost) <= cfg.trainExplainMiles) return (before ?? after)!.trainId
  }
  return null
}

/**
 * A train position arrived (possibly late, possibly out of order). Any
 * unexplained spike along the train's path between this fix and its
 * neighbours is now explained; hazards built on those spikes are downgraded.
 */
export async function onTrainPosition(store: CorrelatorStore, fix: TrainFix, subdivisionId: string, trigger: Trigger, cfg: CorrelationConfig): Promise<Outcome> {
  const { before, after } = await store.trainFixesAdjacent(fix.trainId, fix.occurredAt)
  const spans: Array<[TrainFix, TrainFix]> = []
  if (before) spans.push([before, fix])
  if (after) spans.push([fix, after])
  if (spans.length === 0) spans.push([fix, fix])
  const explained = new Map<string, Evidence>()
  for (const [a, b] of spans) {
    const lo = Math.min(a.milepost, b.milepost) - cfg.trainExplainMiles
    const hi = Math.max(a.milepost, b.milepost) + cfg.trainExplainMiles
    const from = new Date(Date.parse(a.occurredAt) - cfg.trainExtrapolateSeconds * 1000).toISOString()
    const to = new Date(Date.parse(b.occurredAt) + cfg.trainExtrapolateSeconds * 1000).toISOString()
    for (const e of await store.unexplainedVibration(subdivisionId, lo, hi, from, to)) {
      const mp = trainMilepostAt(a === b ? null : a, a === b ? a : b, e.occurredAt, cfg.trainExtrapolateSeconds) ?? trainMilepostAt(a, null, e.occurredAt, cfg.trainExtrapolateSeconds)
      if (mp !== null && Math.abs(mp - e.milepost) <= cfg.trainExplainMiles) explained.set(e.eventId, e)
    }
  }
  if (explained.size === 0) return { kind: 'none', events: [] }
  await store.updateEvidence([...explained.keys()], { explainedByTrain: fix.trainId })

  const byHazard = new Map<string, Evidence[]>()
  for (const e of explained.values()) if (e.hazardId) byHazard.set(e.hazardId, [...(byHazard.get(e.hazardId) ?? []), e])
  const names: string[] = []
  for (const [hazardId, removed] of byHazard) {
    const state = await store.hazardStreamState(hazardId)
    if (!state?.open) continue
    const h = await store.hazardRecord(hazardId)
    if (!h) continue
    h.streamVersion = state.version
    const remaining = (await store.hazardEvidence(hazardId)).filter((e) => !explained.has(e.eventId))
    const confidence = combinedConfidence(remaining)
    const cls = classify(confidence, cfg)
    if (confidence >= h.confidence) continue
    const d = draft('HazardDowngraded', {
      hazardId,
      fromSeverity: h.severity,
      toSeverity: cls.severity,
      fromStatus: h.detectionStatus,
      toStatus: cls.detectionStatus,
      confidence,
      reason: `${removed.length} vibration spike${removed.length > 1 ? 's' : ''} explained by train ${fix.symbol} passing (position reported late)`,
      removedEvidence: removed.map((e) => e.eventId),
    })
    h.confidence = round3(confidence)
    h.severity = cls.severity
    h.detectionStatus = cls.detectionStatus
    h.streamVersion = await store.appendHazard(h, [d], trigger)
    await store.saveHazard(h)
    names.push('HazardDowngraded')
  }
  return { kind: names.length ? 'attached' : 'none', events: names }
}

export interface RailTempInput {
  sensorId: string
  subdivisionId: string
  segmentId: string
  segmentStartMp: number
  segmentEndMp: number
  neutralTempF: number
  sample: Sample
}

/** Rail temperature trend: HazardRiskElevated when the band rises into elevated/critical, HazardRiskSubsided when it falls back. */
export async function onRailTemp(store: CorrelatorStore, input: RailTempInput, trigger: Trigger, heatCfg: HeatConfig): Promise<Outcome> {
  await store.addRailTempSample(input.sensorId, input.sample)
  const since = new Date(Date.parse(input.sample.occurredAt) - (heatCfg.trendMinutes + 1) * 60_000).toISOString()
  const assessment = assessHeat(await store.railTempSamples(input.sensorId, since), input.neutralTempF, heatCfg)
  if (!assessment) return { kind: 'none', events: [] }
  const state = (await store.heatState(input.segmentId)) ?? { band: 'normal', hazardId: null }
  let stream = state.hazardId ? await store.hazardStreamState(state.hazardId) : null
  if (stream && !stream.open) stream = null
  const prevBand = (stream ? state.band : 'normal') as keyof typeof BAND_RANK
  const band = assessment.band

  if ((band === 'elevated' || band === 'critical') && BAND_RANK[band] > BAND_RANK[prevBand]) {
    const ids = stream && state.hazardId ? { hazardId: state.hazardId, code: '' } : await store.newHazard()
    const h: HazardRecord = {
      hazardId: ids.hazardId,
      code: ids.code,
      kind: 'rail_buckling_risk',
      subdivisionId: input.subdivisionId,
      segmentId: input.segmentId,
      mpFrom: input.segmentStartMp,
      mpTo: input.segmentEndMp,
      confidence: 1,
      severity: band === 'critical' ? 'HIGH' : 'MEDIUM',
      detectionStatus: 'risk_elevated',
      firstEvidenceAt: input.sample.occurredAt,
      streamVersion: stream?.version ?? 0,
    }
    if (!h.code) {
      const existing = await store.hazardRecord(h.hazardId)
      h.code = existing?.code ?? h.hazardId.slice(0, 8)
      h.firstEvidenceAt = existing?.firstEvidenceAt ?? h.firstEvidenceAt
    }
    const d = draft('HazardRiskElevated', {
      hazardId: h.hazardId,
      code: h.code,
      kind: 'rail_buckling_risk',
      subdivisionId: h.subdivisionId,
      segmentId: h.segmentId,
      mpFrom: h.mpFrom,
      mpTo: h.mpTo,
      band,
      severity: h.severity,
      sensorId: input.sensorId,
      railTempF: assessment.currentF,
      neutralTempF: input.neutralTempF,
      projectedTempF: assessment.projectedF,
      slopeFPerMin: assessment.slopeFPerMin,
      trigger: { eventId: trigger.eventId, occurredAt: trigger.occurredAt, recordedAt: trigger.recordedAt, lane: trigger.lane, late: trigger.late },
    })
    h.streamVersion = await store.appendHazard(h, [d], trigger)
    await store.saveHazard(h)
    await store.setHeatState(input.segmentId, band, h.hazardId)
    return { kind: 'detected', hazardId: h.hazardId, events: ['HazardRiskElevated'] }
  }

  if (stream && state.hazardId && BAND_RANK[prevBand] >= BAND_RANK.elevated && assessment.currentBand !== 'elevated' && assessment.currentBand !== 'critical' && BAND_RANK[assessment.projectedBand] <= BAND_RANK.watch) {
    const h = await store.hazardRecord(state.hazardId)
    if (h) {
      h.streamVersion = stream.version
      h.detectionStatus = 'risk_subsided'
      h.streamVersion = await store.appendHazard(h, [draft('HazardRiskSubsided', { hazardId: h.hazardId, railTempF: assessment.currentF, projectedTempF: assessment.projectedF })], trigger)
      await store.saveHazard(h)
    }
    await store.setHeatState(input.segmentId, band, state.hazardId)
    return { kind: 'attached', hazardId: state.hazardId, events: ['HazardRiskSubsided'] }
  }
  return { kind: 'none', events: [] }
}
