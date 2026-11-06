/**
 * The simulated world: trains moving along the line, sensors producing edge
 * aggregates, one gateway per track segment, and the PTC feed that reports
 * train positions. All event times are wall-clock time.
 */
import { randomUUID } from 'node:crypto'
import { SEGMENTS, SENSORS, subdivisionAt, type Sensor } from '../shared/track.js'
import { postBatch, type EdgeEvent } from './client.js'
import { Gateway } from './gateway.js'
import { between, mulberry32, round1 } from './rng.js'

export interface Train {
  trainId: string
  symbol: string
  milepost: number
  direction: 'increasing' | 'decreasing'
  speedMph: number
}

/** Rail temperature profile overrides: segment -> function of scenario seconds giving degrees above RNT. */
export type HeatProfile = Map<string, (t: number) => number>

export class World {
  readonly rng = mulberry32(1747)
  readonly gateways = new Map<string, Gateway>()
  readonly trains: Train[]
  readonly deadSensors = new Set<string>()
  readonly heat: HeatProfile = new Map()
  /** Water level overrides: sensor -> inches below rail as a function of scenario seconds. */
  readonly water = new Map<string, (t: number) => number>()
  /** Trains whose PTC reports are being held back (a comms gap), delivered when the gap ends. */
  readonly ptcGaps = new Set<string>()
  private ptcSeq = Date.now() * 100
  private ptcBuffer: EdgeEvent[] = []
  private lastReading = new Map<string, number>()
  private missedFlagged = new Set<string>()
  readonly startedAt = Date.now()

  constructor(trains: Train[]) {
    this.trains = trains
    for (const seg of SEGMENTS) {
      // Canyon gateways still run v1 camera firmware; Prairie gateways run v2 (bounding boxes).
      this.gateways.set(seg.gatewayId, new Gateway(seg.gatewayId, seg.subdivisionId === 'CAN' ? 1 : 2))
    }
  }

  t(): number {
    return (Date.now() - this.startedAt) / 1000
  }

  gateway(id: string): Gateway {
    return this.gateways.get(id)!
  }

  moveTrains(dtSec: number): void {
    for (const tr of this.trains) {
      const sign = tr.direction === 'increasing' ? 1 : -1
      tr.milepost += (sign * tr.speedMph * dtSec) / 3600
    }
  }

  /** Distance from the nearest train to a milepost, in miles. */
  nearestTrainMiles(mp: number): number {
    return this.trains.reduce((m, tr) => Math.min(m, Math.abs(tr.milepost - mp)), Number.POSITIVE_INFINITY)
  }

  /** Emits one camera detection, in the schema version the sensor's gateway firmware speaks. */
  camera(sensor: Sensor, at: Date, detectionClass: string, confidence: number): EdgeEvent {
    const gw = this.gateway(sensor.gatewayId)
    const base = { sensorId: sensor.id, detectionClass, confidence: round1(confidence * 100) / 100, imageRef: `s3://edge-frames/${sensor.id}/${at.getTime()}.jpg` }
    if (gw.cameraSchemaVersion === 1) return gw.emit('CameraDetectionReported', at, base, 1)
    const bbox = detectionClass === 'clear' ? null : { x: round1(between(this.rng, 0.2, 0.5) * 100) / 100, y: 0.55, w: 0.22, h: 0.18 }
    return gw.emit('CameraDetectionReported', at, { ...base, bbox, modelVersion: 'yolo-rail-2.3' }, 2)
  }

  /** Periodic readings for every live sensor whose interval has elapsed. */
  readings(now: Date): void {
    const t = this.t()
    for (const s of SENSORS) {
      if (this.deadSensors.has(s.id)) continue
      const interval = s.type === 'geophone' ? 10 : s.type === 'slide_fence' ? Number.POSITIVE_INFINITY : 30
      const last = this.lastReading.get(s.id) ?? this.startedAt - this.rng() * interval * 1000
      if (now.getTime() - last < interval * 1000) continue
      this.lastReading.set(s.id, now.getTime())
      this.missedFlagged.delete(s.id)
      const gw = this.gateway(s.gatewayId)
      if (s.type === 'geophone') {
        const near = this.nearestTrainMiles(s.milepost)
        const peak = near <= 0.35 ? between(this.rng, 14, 26) : between(this.rng, 0.3, 2.5)
        gw.emit('SensorReadingReported', now, { sensorId: s.id, kind: 'vibration', windowSec: 10, peakMmS: round1(peak), rmsMmS: round1(peak * 0.35) })
      } else if (s.type === 'rail_temp') {
        const profile = this.heat.get(s.segmentId)
        const above = profile ? profile(t) : 12 + Math.sin(s.milepost) * 3
        gw.emit('SensorReadingReported', now, { sensorId: s.id, kind: 'rail_temp', windowSec: 30, tempF: round1((s.neutralTempF ?? 95) + above + between(this.rng, -0.4, 0.4)) })
      } else if (s.type === 'water_level') {
        const level = this.water.get(s.id)?.(t) ?? 60 + Math.cos(s.milepost) * 10
        gw.emit('WaterLevelReported', now, { sensorId: s.id, inchesBelowRail: round1(level), risingInPerHr: this.water.has(s.id) ? 4.5 : 0 })
      } else if (s.type === 'camera') {
        this.camera(s, now, 'clear', between(this.rng, 0.9, 0.99))
      }
    }
    // The gateway notices a sensor that stopped reporting (3 missed intervals) and says so once.
    for (const id of this.deadSensors) {
      const s = SENSORS.find((x) => x.id === id)
      const last = this.lastReading.get(id)
      if (!s || last === undefined || this.missedFlagged.has(id)) continue
      if (now.getTime() - last >= 30_000) {
        this.missedFlagged.add(id)
        this.gateway(s.gatewayId).emit('SensorHeartbeatMissed', now, { sensorId: id, lastSeenAt: new Date(last).toISOString(), missedIntervals: 3 })
      }
    }
  }

  /** The PTC feed: every train's position; trains in a comms gap are held and delivered later (late, in order). */
  async reportTrains(now: Date): Promise<void> {
    for (const tr of this.trains) {
      const sub = subdivisionAt(tr.milepost)
      if (!sub) continue
      this.ptcSeq += 1
      const e: EdgeEvent = {
        eventId: randomUUID(),
        seq: this.ptcSeq,
        type: 'TrainPositionReported',
        version: 1,
        occurredAt: now.toISOString(),
        payload: { trainId: tr.trainId, symbol: tr.symbol, subdivisionId: sub.id, milepost: Math.round(tr.milepost * 1000) / 1000, direction: tr.direction, speedMph: tr.speedMph },
      }
      this.ptcBuffer.push(e)
    }
    const sendable = this.ptcBuffer.filter((e) => !this.ptcGaps.has(String((e.payload as { trainId: string }).trainId)))
    if (sendable.length === 0) return
    try {
      await postBatch({ sourceId: 'PTC', batchId: randomUUID(), events: sendable })
      const sent = new Set(sendable.map((e) => e.eventId))
      this.ptcBuffer = this.ptcBuffer.filter((e) => !sent.has(e.eventId))
    } catch {
      // keep buffered
    }
  }

  async flushGateways(): Promise<void> {
    await Promise.all([...this.gateways.values()].map((g) => g.flush()))
  }

  pendingEdgeEvents(): number {
    return [...this.gateways.values()].reduce((n, g) => n + g.buffered, 0) + this.ptcBuffer.length
  }
}
