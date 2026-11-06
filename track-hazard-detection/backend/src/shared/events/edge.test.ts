import { describe, expect, it } from 'vitest'
import { PermanentError } from './envelope.js'
import { classifyLane, parseEdgePayload, upcastEdge } from './edge.js'

const v1 = { sensorId: 'CAM-136.2', detectionClass: 'debris', confidence: 0.66, imageRef: 's3://f/1.jpg' }

describe('schema evolution: CameraDetectionReported', () => {
  it('upcasts v1 to v2 with a null bounding box and an unreported model version', () => {
    const lifted = upcastEdge('CameraDetectionReported', 1, v1)
    expect(lifted.version).toBe(2)
    expect(lifted.payload).toMatchObject({ ...v1, bbox: null, modelVersion: 'edge-v1 (unreported)' })
    expect(parseEdgePayload('CameraDetectionReported', 1, v1).bbox).toBeNull()
  })

  it('passes v2 through unchanged and ignores unknown extra fields (tolerant reader)', () => {
    const v2 = { ...v1, bbox: { x: 0.2, y: 0.5, w: 0.2, h: 0.1 }, modelVersion: 'yolo-rail-2.3', extra: 'ignored' }
    const parsed = parseEdgePayload('CameraDetectionReported', 2, v2)
    expect(parsed.modelVersion).toBe('yolo-rail-2.3')
    expect(parsed.bbox).toEqual(v2.bbox)
  })

  it('refuses a version newer than the cloud knows (dead-lettered, never guessed)', () => {
    expect(() => parseEdgePayload('CameraDetectionReported', 3, v1)).toThrow(PermanentError)
    try {
      upcastEdge('CameraDetectionReported', 3, v1)
    } catch (err) {
      expect((err as PermanentError).code).toBe('UNSUPPORTED_VERSION')
    }
  })

  it('rejects a payload that fails the latest schema as SCHEMA_INVALID', () => {
    try {
      parseEdgePayload('WaterLevelReported', 1, { sensorId: 'WTR-207.9', inchesBelowRail: 'ERR', risingInPerHr: 0 })
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(PermanentError)
      expect((err as PermanentError).code).toBe('SCHEMA_INVALID')
    }
  })

  it('rejects unknown types', () => {
    expect(() => upcastEdge('MysteryEvent', 1, {})).toThrow(/Unknown edge event type/)
  })
})

describe('priority lane policy', () => {
  it('puts possible hazards on the critical lane and readings on bulk', () => {
    expect(classifyLane('SlideFenceTripped', {})).toBe('critical')
    expect(classifyLane('CameraDetectionReported', { detectionClass: 'vehicle' })).toBe('critical')
    expect(classifyLane('CameraDetectionReported', { detectionClass: 'clear' })).toBe('bulk')
    expect(classifyLane('SensorReadingReported', { kind: 'vibration', peakMmS: 30 })).toBe('critical')
    expect(classifyLane('SensorReadingReported', { kind: 'vibration', peakMmS: 1.2 })).toBe('bulk')
    expect(classifyLane('SensorReadingReported', { kind: 'rail_temp', tempF: 140 })).toBe('bulk')
    expect(classifyLane('WaterLevelReported', { inchesBelowRail: 20 })).toBe('critical')
    expect(classifyLane('WaterLevelReported', { inchesBelowRail: 'ERR' })).toBe('bulk')
    expect(classifyLane('SensorHeartbeatMissed', {})).toBe('bulk')
  })
})
