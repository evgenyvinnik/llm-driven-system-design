/**
 * The scripted afternoon (seconds after start, real time). Every location and
 * number is illustrative.
 *
 *   20  GEO-122.0 dies; its gateway reports SensorHeartbeatMissed ~30 s later
 *   45  CAM-136.2 (tunnel portal, v1 firmware) sees debris, 0.66 -> HIGH obstruction
 *   55  GW-CAN-4 loses its link and buffers
 *   58  GEO-135.9 spike while GW-CAN-4 is offline (buffered at the edge)
 *   90  rockfall at MP 147.8: two fence wires + a geophone -> one CRITICAL hazard
 *    0  hot afternoon: PRA-3 rail is 22 F over RNT and climbing 2.4 F/min -> elevated
 *       risk (~90 s) and a 40 mph standing heat order, critical (~330 s) and 25 mph;
 *       PRA-4 climbs 1.8 F/min -> elevated (~240 s)
 *  150  GW-PRA-1 uploads a 3,000-event backlog from an outage this morning (bulk lane)
 *  153  crossing obstruction at MP 241.3: camera vehicle 0.71, during the backlog
 *  153  GW-PRA-7's reply is lost: it resends the batch (duplicates)
 *  159  GEO-241.5 spike confirms it -> CRITICAL, trains warned nearest first
 *  175  GW-CAN-4 reconnects: critical first, then its backlog, one batch twice;
 *       the late spike upgrades the tunnel hazard to CRITICAL
 *  230  a malformed WaterLevelReported ("ERR") -> DLQ (schema invalid)
 *  245  readings from GEO-118.9, a sensor not yet in the registry -> retried, then DLQ
 *  260  CameraDetectionReported v3 from beta firmware -> DLQ (unsupported version)
 *  270  Q-CANEXP's PTC reports stop (comms gap) while it passes GEO-165.4/165.7:
 *       two unexplained spikes -> suspected rockfall (HIGH)
 *  280  Bridge 171.2 water starts rising; crosses 24 in below rail ~310 -> high water
 *  370  the held PTC reports arrive late -> the suspected rockfall is downgraded
 */
import { SENSOR_BY_ID, UNREGISTERED_SENSOR } from '../shared/track.js'
import type { Gateway } from './gateway.js'
import { between, round1 } from './rng.js'
import type { Train, World } from './world.js'

export const TRAINS: Train[] = [
  { trainId: 'Q-CANEXP-06', symbol: 'Q-CANEXP', milepost: 161.0, direction: 'increasing', speedMph: 50 },
  { trainId: 'C-COALWB-02', symbol: 'C-COALWB', milepost: 159.5, direction: 'decreasing', speedMph: 30 },
  { trainId: 'M-PRACAN-05', symbol: 'M-PRACAN', milepost: 214.0, direction: 'increasing', speedMph: 40 },
  { trainId: 'Z-CHIPRA-04', symbol: 'Z-CHIPRA', milepost: 258.5, direction: 'decreasing', speedMph: 55 },
]

export interface Step {
  at: number
  label: string
  run: (w: World) => void
}

const sensor = (id: string) => SENSOR_BY_ID.get(id)!
const now = () => new Date()

function vibration(w: World, id: string, peak: number): void {
  const s = sensor(id)
  w.gateway(s.gatewayId).emit('SensorReadingReported', now(), { sensorId: s.id, kind: 'vibration', windowSec: 10, peakMmS: peak, rmsMmS: round1(peak * 0.4) })
}

function fence(w: World, id: string, wire: number): void {
  const s = sensor(id)
  w.gateway(s.gatewayId).emit('SlideFenceTripped', now(), { sensorId: s.id, wire, interlockSignalDropped: true, signalId: `${s.subdivisionId}-${Math.round(s.milepost * 10)}W` })
}

/** A morning outage's worth of quiet readings, replayed from the gateway's disk. */
function backlog(w: World, gw: Gateway, count: number): void {
  const ids = ['GEO-186.6', 'RTS-185.0', 'CAM-186.4']
  const start = Date.now() - 2 * 3600_000
  for (let i = 0; i < count; i++) {
    const s = sensor(ids[i % ids.length])
    const at = new Date(start + (i * 3600_000) / count)
    if (s.type === 'geophone') gw.emit('SensorReadingReported', at, { sensorId: s.id, kind: 'vibration', windowSec: 10, peakMmS: round1(between(w.rng, 0.3, 2)), rmsMmS: 0.4 })
    else if (s.type === 'rail_temp') gw.emit('SensorReadingReported', at, { sensorId: s.id, kind: 'rail_temp', windowSec: 30, tempF: round1(100 + i / 200) })
    else w.camera(s, at, 'clear', 0.97)
  }
}

export const SCENARIO: Step[] = [
  {
    // At 0, so the profile is in place before the first rail-temperature sample (a step change would read as a steep trend).
    at: 0,
    label: 'Hot afternoon: rail temperatures climbing on PRA-3 (2.4 F/min) and PRA-4 (1.8 F/min)',
    run: (w) => {
      w.heat.set('PRA-3', (t) => 22 + t * (2.4 / 60))
      w.heat.set('PRA-4', (t) => 18 + t * (1.8 / 60))
    },
  },
  { at: 20, label: 'GEO-122.0 stops reporting (dead sensor)', run: (w) => w.deadSensors.add('GEO-122.0') },
  { at: 45, label: 'CAM-136.2 sees debris at the tunnel portal (0.66)', run: (w) => void w.camera(sensor('CAM-136.2'), now(), 'debris', 0.66) },
  { at: 55, label: 'GW-CAN-4 loses its link', run: (w) => (w.gateway('GW-CAN-4').online = false) },
  { at: 58, label: 'GEO-135.9 spike (buffered at the edge)', run: (w) => vibration(w, 'GEO-135.9', 36) },
  { at: 90, label: 'Rockfall MP 147.8: fence wire 2', run: (w) => fence(w, 'FNC-147.8', 2) },
  { at: 91.5, label: 'Rockfall MP 147.8: GEO-147.9 spike', run: (w) => vibration(w, 'GEO-147.9', 38) },
  { at: 94, label: 'Rockfall MP 147.8: fence wire 4', run: (w) => fence(w, 'FNC-147.8', 4) },
  { at: 150, label: 'GW-PRA-1 uploads a 3,000-event backlog', run: (w) => backlog(w, w.gateway('GW-PRA-1'), 3000) },
  {
    at: 153,
    label: 'CAM-241.3 sees a vehicle on the Hwy 9 crossing (0.71); GW-PRA-7 reply lost',
    run: (w) => {
      w.gateway('GW-PRA-7').loseNextAck()
      w.camera(sensor('CAM-241.3'), now(), 'vehicle', 0.71)
    },
  },
  { at: 159, label: 'GEO-241.5 spike confirms the crossing obstruction', run: (w) => vibration(w, 'GEO-241.5', 27) },
  {
    at: 175,
    label: 'GW-CAN-4 reconnects (backlog, one batch delivered twice)',
    run: (w) => {
      const gw = w.gateway('GW-CAN-4')
      gw.loseNextAck()
      gw.online = true
    },
  },
  {
    at: 230,
    label: 'Malformed WaterLevelReported from WTR-207.9',
    run: (w) => void w.gateway('GW-PRA-3').emit('WaterLevelReported', now(), { sensorId: 'WTR-207.9', inchesBelowRail: 'ERR', risingInPerHr: 0 }),
  },
  {
    at: 245,
    label: `Readings from unregistered ${UNREGISTERED_SENSOR.id}`,
    run: (w) => void w.gateway(UNREGISTERED_SENSOR.gatewayId).emit('SensorReadingReported', now(), { sensorId: UNREGISTERED_SENSOR.id, kind: 'vibration', windowSec: 10, peakMmS: 1.1, rmsMmS: 0.4 }),
  },
  {
    at: 260,
    label: 'CameraDetectionReported v3 from beta firmware',
    run: (w) =>
      void w.gateway('GW-PRA-6').emit('CameraDetectionReported', now(), { sensorId: 'CAM-252.7', detectionClass: 'clear', confidence: 0.95, imageRef: 's3://edge-frames/beta.jpg', bbox: null, modelVersion: 'yolo-rail-3.0-beta', track: 'main' }, 3),
  },
  { at: 270, label: 'Q-CANEXP PTC reports held (comms gap)', run: (w) => w.ptcGaps.add('Q-CANEXP-06') },
  { at: 280, label: 'Bridge 171.2 water starts rising', run: (w) => w.water.set('WTR-171.2', (t) => Math.max(18, 40 - Math.max(0, t - 280) * 0.4)) },
  { at: 370, label: 'Q-CANEXP PTC reports delivered (late)', run: (w) => w.ptcGaps.delete('Q-CANEXP-06') },
]
