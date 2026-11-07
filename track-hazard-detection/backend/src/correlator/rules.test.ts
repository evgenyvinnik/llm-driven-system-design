import { describe, expect, it } from 'vitest'
import { canAttach, classify, combinedConfidence, evidenceFromEdge, hazardKindFor, inWindow, trainMilepostAt, type HazardRecord } from './rules.js'

const cfg = { windowSeconds: 30, radiusMiles: 0.5, detectThreshold: 0.5, confirmThreshold: 0.8, vibrationSpikeMmS: 12 }

describe('combining evidence', () => {
  it('uses a noisy-OR across sensors', () => {
    expect(combinedConfidence([{ sensorId: 'A', confidence: 0.71, explainedByTrain: null }, { sensorId: 'B', confidence: 0.425, explainedByTrain: null }])).toBeCloseTo(0.833, 3)
  })
  it('counts one sensor once (its best report), so resends and second wires never inflate confidence', () => {
    expect(
      combinedConfidence([
        { sensorId: 'FNC', confidence: 0.85, explainedByTrain: null },
        { sensorId: 'FNC', confidence: 0.85, explainedByTrain: null },
      ]),
    ).toBe(0.85)
  })
  it('ignores evidence a train explained', () => {
    expect(combinedConfidence([{ sensorId: 'G', confidence: 0.45, explainedByTrain: 'Q-1' }])).toBe(0)
  })
  it('maps confidence to severity', () => {
    expect(classify(0.85, cfg)).toEqual({ severity: 'CRITICAL', detectionStatus: 'confirmed' })
    expect(classify(0.6, cfg)).toEqual({ severity: 'HIGH', detectionStatus: 'detected' })
    expect(classify(0.3, cfg)).toEqual({ severity: 'LOW', detectionStatus: 'unconfirmed' })
  })
  it('names the hazard from the most specific evidence', () => {
    expect(hazardKindFor([{ kind: 'ground_vibration' }, { kind: 'fence_break' }])).toBe('rockfall')
    expect(hazardKindFor([{ kind: 'ground_vibration' }, { kind: 'camera_obstruction' }])).toBe('obstruction')
    expect(hazardKindFor([{ kind: 'ground_vibration' }])).toBe('rockfall')
  })
})

describe('evidence from edge events', () => {
  it('ignores quiet readings and clear frames', () => {
    expect(evidenceFromEdge({ type: 'SensorReadingReported', payload: { kind: 'vibration', peakMmS: 2 } }, cfg)).toBeNull()
    expect(evidenceFromEdge({ type: 'CameraDetectionReported', payload: { detectionClass: 'clear', confidence: 0.99 } }, cfg)).toBeNull()
    expect(evidenceFromEdge({ type: 'WaterLevelReported', payload: { inchesBelowRail: 50 } }, cfg)).toBeNull()
  })
  it('turns spikes, detections, fence trips and high water into evidence', () => {
    expect(evidenceFromEdge({ type: 'SensorReadingReported', payload: { kind: 'vibration', peakMmS: 36 } }, cfg)).toMatchObject({ kind: 'ground_vibration', confidence: 0.47 })
    expect(evidenceFromEdge({ type: 'CameraDetectionReported', payload: { detectionClass: 'vehicle', confidence: 0.71 } }, cfg)).toMatchObject({ kind: 'camera_obstruction', confidence: 0.71 })
    expect(evidenceFromEdge({ type: 'SlideFenceTripped', payload: { wire: 2 } }, cfg)).toMatchObject({ kind: 'fence_break', confidence: 0.85 })
    expect(evidenceFromEdge({ type: 'WaterLevelReported', payload: { inchesBelowRail: 4 } }, cfg)).toMatchObject({ kind: 'high_water', confidence: 0.9 })
  })
})

describe('windows', () => {
  const at = (s: number) => new Date(Date.UTC(2026, 10, 6, 15, 0, s)).toISOString()
  it('is a 30 s x 0.5 mi box in event time', () => {
    expect(inWindow({ milepost: 241.3, occurredAt: at(0) }, { milepost: 241.5, occurredAt: at(6) }, cfg)).toBe(true)
    expect(inWindow({ milepost: 241.3, occurredAt: at(0) }, { milepost: 241.9, occurredAt: at(6) }, cfg)).toBe(false)
    expect(inWindow({ milepost: 241.3, occurredAt: at(0) }, { milepost: 241.5, occurredAt: at(45) }, cfg)).toBe(false)
  })
  it('lets compatible evidence join an open hazard but not much older evidence', () => {
    const h: HazardRecord = { hazardId: 'h', code: 'HZ-1', kind: 'obstruction', subdivisionId: 'PRA', segmentId: 'PRA-7', mpFrom: 241.3, mpTo: 241.3, confidence: 0.71, severity: 'HIGH', detectionStatus: 'detected', firstEvidenceAt: at(30), streamVersion: 1 }
    const ev = { eventId: 'e', kind: 'ground_vibration' as const, sensorId: 'GEO', subdivisionId: 'PRA', segmentId: 'PRA-7', milepost: 241.5, occurredAt: at(35), confidence: 0.4, late: false, explainedByTrain: null, hazardId: null, details: {} }
    expect(canAttach(h, ev, cfg)).toBe(true)
    expect(canAttach(h, { ...ev, occurredAt: at(0) }, cfg)).toBe(true) // 30 s before is still in the window
    expect(canAttach(h, { ...ev, kind: 'fence_break' }, cfg)).toBe(false) // a fence break is not an obstruction
    expect(canAttach(h, { ...ev, milepost: 242.2 }, cfg)).toBe(false)
  })
})

describe('train position at a time', () => {
  const fix = (s: number, mp: number) => ({ trainId: 'Q', symbol: 'Q', milepost: mp, direction: 'increasing' as const, speedMph: 60, occurredAt: new Date(Date.UTC(2026, 10, 6, 15, 0, s)).toISOString() })
  const at = (s: number) => new Date(Date.UTC(2026, 10, 6, 15, 0, s)).toISOString()
  it('interpolates between fixes', () => {
    expect(trainMilepostAt(fix(0, 100), fix(10, 101), at(5), 30)).toBeCloseTo(100.5)
  })
  it('extrapolates a short way at the reported speed, and gives up beyond that', () => {
    expect(trainMilepostAt(fix(0, 100), null, at(20), 30)).toBeCloseTo(100 + 60 * (20 / 3600))
    expect(trainMilepostAt(fix(0, 100), null, at(45), 30)).toBeNull()
  })
})
