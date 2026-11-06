import { describe, expect, it } from 'vitest'
import { correlateEvidence, onRailTemp, onTrainPosition, type Trigger } from './engine.js'
import { MemoryCorrelatorStore } from './memory-store.js'
import { mulberry32 } from '../simulator/rng.js'
import type { Evidence, TrainFix } from './rules.js'

const cfg = { windowSeconds: 30, radiusMiles: 0.5, detectThreshold: 0.5, confirmThreshold: 0.8, vibrationSpikeMmS: 12, trainExplainMiles: 0.6, trainExtrapolateSeconds: 30 }
const heatCfg = { watchDelta: 25, elevatedDelta: 35, criticalDelta: 45, trendMinutes: 15, projectMinutes: 10 }
const T0 = Date.UTC(2026, 10, 6, 20, 0, 0)
const at = (s: number) => new Date(T0 + s * 1000).toISOString()

let n = 0
function ev(partial: Partial<Evidence> & Pick<Evidence, 'kind' | 'sensorId' | 'milepost' | 'confidence'>, s: number): Evidence {
  n += 1
  return { eventId: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, subdivisionId: 'CAN', segmentId: 'CAN-5', occurredAt: at(s), late: false, explainedByTrain: null, hazardId: null, details: {}, ...partial }
}
const trig = (e: Evidence): Trigger => ({ eventId: e.eventId, occurredAt: e.occurredAt, recordedAt: e.occurredAt, lane: 'critical', late: e.late, correlationId: e.eventId })

async function run(store: MemoryCorrelatorStore, list: Evidence[]) {
  for (const e of list) await correlateEvidence(store, { ...e }, trig(e), cfg)
}

/** The standing hazards, independent of ids and of the history that produced them. */
function standing(store: MemoryCorrelatorStore) {
  return [...store.hazards.values()]
    .filter((h) => h.confidence >= cfg.detectThreshold)
    .map((h) => ({ kind: h.kind, mpFrom: h.mpFrom, mpTo: h.mpTo, confidence: h.confidence, severity: h.severity, evidence: [...store.evidence.values()].filter((e) => e.hazardId === h.hazardId).map((e) => e.eventId).sort() }))
    .sort((a, b) => a.mpFrom - b.mpFrom)
}

const types = (store: MemoryCorrelatorStore) => store.events.map((e) => e.type)

describe('correlation', () => {
  it('confirms a camera obstruction with a vibration spike within 30 s and 0.5 mi', async () => {
    const store = new MemoryCorrelatorStore()
    await run(store, [ev({ kind: 'camera_obstruction', sensorId: 'CAM-241.3', milepost: 241.3, confidence: 0.71, subdivisionId: 'PRA' }, 0), ev({ kind: 'ground_vibration', sensorId: 'GEO-241.5', milepost: 241.5, confidence: 0.425, subdivisionId: 'PRA' }, 6)])
    expect(types(store)).toEqual(['HazardDetected', 'HazardEvidenceAdded', 'HazardUpgraded'])
    const [h] = standing(store)
    expect(h).toMatchObject({ kind: 'obstruction', severity: 'CRITICAL', confidence: 0.833, mpFrom: 241.3, mpTo: 241.5 })
  })

  it('turns several sensors seeing one rockfall into one HazardDetected', async () => {
    const store = new MemoryCorrelatorStore()
    await run(store, [
      ev({ kind: 'fence_break', sensorId: 'FNC-147.8', milepost: 147.8, confidence: 0.85 }, 0),
      ev({ kind: 'ground_vibration', sensorId: 'GEO-147.9', milepost: 147.9, confidence: 0.48 }, 1.5),
      ev({ kind: 'fence_break', sensorId: 'FNC-147.8', milepost: 147.8, confidence: 0.85 }, 4),
    ])
    expect(types(store).filter((t) => t === 'HazardDetected')).toHaveLength(1)
    expect(store.hazards.size).toBe(1)
    // The second wire on the same fence is kept as evidence but changes nothing, so no event is appended for it.
    expect(types(store)).toEqual(['HazardDetected', 'HazardEvidenceAdded'])
    expect(standing(store)[0].evidence).toHaveLength(3)
  })

  it('gives the same standing hazards whatever order the evidence arrives in', async () => {
    const base = [
      ev({ kind: 'camera_obstruction', sensorId: 'CAM-241.3', milepost: 241.3, confidence: 0.71, subdivisionId: 'PRA' }, 100),
      ev({ kind: 'ground_vibration', sensorId: 'GEO-241.5', milepost: 241.5, confidence: 0.425, subdivisionId: 'PRA' }, 106),
      ev({ kind: 'fence_break', sensorId: 'FNC-147.8', milepost: 147.8, confidence: 0.85 }, 0),
      ev({ kind: 'ground_vibration', sensorId: 'GEO-147.9', milepost: 147.9, confidence: 0.48 }, 1.5),
      ev({ kind: 'fence_break', sensorId: 'FNC-147.8', milepost: 147.8, confidence: 0.85 }, 4),
      ev({ kind: 'ground_vibration', sensorId: 'GEO-104.5', milepost: 104.5, confidence: 0.4 }, 50),
      ev({ kind: 'high_water', sensorId: 'WTR-171.2', milepost: 171.2, confidence: 0.6 }, 70),
    ]
    const reference = new MemoryCorrelatorStore()
    await run(reference, [...base].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt)))
    const expected = standing(reference)
    expect(expected).toHaveLength(3)
    const rng = mulberry32(7)
    for (let i = 0; i < 25; i++) {
      const shuffled = [...base].sort(() => rng() - 0.5)
      const store = new MemoryCorrelatorStore()
      await run(store, shuffled)
      expect(standing(store)).toEqual(expected)
    }
  })

  it('is a no-op when the same evidence is redelivered', async () => {
    const store = new MemoryCorrelatorStore()
    const cam = ev({ kind: 'camera_obstruction', sensorId: 'CAM-186.4', milepost: 186.4, confidence: 0.7, subdivisionId: 'PRA' }, 0)
    await run(store, [cam])
    const before = store.events.length
    await run(store, [cam, cam])
    expect(store.events.length).toBe(before)
  })

  it('lets a late spike upgrade an open hazard', async () => {
    const store = new MemoryCorrelatorStore()
    await run(store, [ev({ kind: 'camera_obstruction', sensorId: 'CAM-136.2', milepost: 136.2, confidence: 0.66 }, 0)])
    expect(standing(store)[0].severity).toBe('HIGH')
    // Buffered at an offline gateway, delivered two minutes later.
    await run(store, [ev({ kind: 'ground_vibration', sensorId: 'GEO-135.9', milepost: 135.9, confidence: 0.47, late: true }, 13)])
    const up = store.events.find((e) => e.type === 'HazardUpgraded')!
    expect(up.payload).toMatchObject({ fromSeverity: 'HIGH', toSeverity: 'CRITICAL', late: true })
  })

  it('opens a new hazard for evidence after the old one was cleared', async () => {
    const store = new MemoryCorrelatorStore()
    await run(store, [ev({ kind: 'fence_break', sensorId: 'FNC-113.0', milepost: 113.0, confidence: 0.85 }, 0)])
    store.close([...store.hazards.keys()][0])
    await run(store, [ev({ kind: 'fence_break', sensorId: 'FNC-113.0', milepost: 113.0, confidence: 0.85 }, 20)])
    expect(types(store).filter((t) => t === 'HazardDetected')).toHaveLength(2)
  })
})

describe('trains and vibration', () => {
  const fix = (s: number, mp: number): TrainFix => ({ trainId: 'Q-CANEXP-06', symbol: 'Q-CANEXP', milepost: mp, direction: 'increasing', speedMph: 50, occurredAt: at(s) })

  it('ignores a spike a passing train explains', async () => {
    const store = new MemoryCorrelatorStore()
    store.addTrainFix(fix(0, 165.3))
    await run(store, [ev({ kind: 'ground_vibration', sensorId: 'GEO-165.4', milepost: 165.4, confidence: 0.42 }, 5), ev({ kind: 'ground_vibration', sensorId: 'GEO-165.7', milepost: 165.7, confidence: 0.4 }, 20)])
    expect(store.events).toHaveLength(0)
    expect([...store.evidence.values()].every((e) => e.explainedByTrain === 'Q-CANEXP-06')).toBe(true)
  })

  it('downgrades a hazard when a late train position explains its spikes', async () => {
    const store = new MemoryCorrelatorStore()
    // The PTC feed went quiet: spikes look unexplained and form a suspected rockfall.
    await run(store, [ev({ kind: 'ground_vibration', sensorId: 'GEO-165.4', milepost: 165.4, confidence: 0.42 }, 40), ev({ kind: 'ground_vibration', sensorId: 'GEO-165.7', milepost: 165.7, confidence: 0.4 }, 61)])
    expect(standing(store)[0]).toMatchObject({ kind: 'rockfall', severity: 'HIGH' })
    // Then the held positions arrive.
    for (const f of [fix(35, 165.33), fix(45, 165.47), fix(55, 165.61), fix(65, 165.75)]) {
      store.addTrainFix(f)
      await onTrainPosition(store, f, 'CAN', { eventId: `t${f.occurredAt}`, occurredAt: f.occurredAt, recordedAt: at(120), lane: 'trains', late: true, correlationId: 'c' }, cfg)
    }
    expect(types(store)).toContain('HazardDowngraded')
    const h = [...store.hazards.values()][0]
    expect(h).toMatchObject({ confidence: 0, severity: 'LOW', detectionStatus: 'unconfirmed' })
    // Downgraded, but never closed automatically: a person decides.
    expect(types(store)).not.toContain('HazardCleared')
  })
})

describe('rail temperature trend', () => {
  it('raises HazardRiskElevated as the band climbs, then HazardRiskSubsided', async () => {
    const store = new MemoryCorrelatorStore()
    const input = (s: number, tempF: number) => ({ sensorId: 'RTS-205.0', subdivisionId: 'PRA', segmentId: 'PRA-3', segmentStartMp: 200, segmentEndMp: 210, neutralTempF: 95, sample: { occurredAt: at(s), tempF } })
    const t = (s: number) => ({ eventId: `r${s}`, occurredAt: at(s), recordedAt: at(s), lane: 'bulk', late: false, correlationId: 'c' })
    for (let i = 0; i <= 30; i++) await onRailTemp(store, input(i * 30, 120 + i), t(i * 30), heatCfg)
    const bands = store.events.filter((e) => e.type === 'HazardRiskElevated').map((e) => e.payload.band)
    expect(bands).toEqual(['elevated', 'critical'])
    expect(store.hazards.size).toBe(1)
    for (let i = 31; i <= 60; i++) await onRailTemp(store, input(i * 30, 115), t(i * 30), heatCfg)
    expect(types(store)).toContain('HazardRiskSubsided')
  })
})
