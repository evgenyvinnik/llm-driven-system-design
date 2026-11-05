/**
 * Latest-state store in Valkey: one hash per locomotive with the newest
 * processed reading. Writes are guarded by sequence number in a Lua script, so
 * a late or replayed reading can never move the state backwards, whichever
 * process writes it.
 * @module shared/state
 */
import { keys, redis } from './cache.js'

export interface LocoState {
  locomotiveId: string
  seq: number
  recordedAt: number
  trainId: string | null
  milepost: number
  speedMph: number
  notch: number
  engineState: string
  fuelRaw: number
  fuelGal: number
  capacityGal: number
  calibration: number
  sensorSuspect: boolean
  leakSuspect: boolean
  lat: number
  lon: number
}

const GUARDED_HSET = `
local cur = redis.call('HGET', KEYS[1], 'seq')
if cur and tonumber(cur) >= tonumber(ARGV[1]) then return 0 end
redis.call('HSET', KEYS[1], unpack(ARGV, 2))
return 1`

export function stateFields(s: LocoState): string[] {
  return [
    'locomotiveId', s.locomotiveId,
    'seq', String(s.seq),
    'recordedAt', String(s.recordedAt),
    'trainId', s.trainId ?? '',
    'milepost', s.milepost.toFixed(3),
    'speedMph', s.speedMph.toFixed(1),
    'notch', String(s.notch),
    'engineState', s.engineState,
    'fuelRaw', s.fuelRaw.toFixed(1),
    'fuelGal', s.fuelGal.toFixed(1),
    'capacityGal', String(s.capacityGal),
    'calibration', s.calibration.toFixed(4),
    'sensorSuspect', s.sensorSuspect ? '1' : '0',
    'leakSuspect', s.leakSuspect ? '1' : '0',
    'lat', s.lat.toFixed(5),
    'lon', s.lon.toFixed(5),
  ]
}

/** Queues a guarded write on a pipeline (or the shared client). Returns nothing; check results on exec. */
export function writeStateGuarded(pipe: { eval: (...args: (string | number)[]) => unknown }, s: LocoState): void {
  pipe.eval(GUARDED_HSET, 1, keys.locoState(s.locomotiveId), String(s.seq), ...stateFields(s))
}

export function parseState(h: Record<string, string>): LocoState | null {
  if (!h || !h.seq) return null
  return {
    locomotiveId: h.locomotiveId,
    seq: Number(h.seq),
    recordedAt: Number(h.recordedAt),
    trainId: h.trainId || null,
    milepost: Number(h.milepost),
    speedMph: Number(h.speedMph),
    notch: Number(h.notch),
    engineState: h.engineState,
    fuelRaw: Number(h.fuelRaw),
    fuelGal: Number(h.fuelGal),
    capacityGal: Number(h.capacityGal),
    calibration: Number(h.calibration || 1),
    sensorSuspect: h.sensorSuspect === '1',
    leakSuspect: h.leakSuspect === '1',
    lat: Number(h.lat),
    lon: Number(h.lon),
  }
}

export async function readStates(ids: string[]): Promise<Map<string, LocoState>> {
  const out = new Map<string, LocoState>()
  if (ids.length === 0) return out
  const pipe = redis.pipeline()
  for (const id of ids) pipe.hgetall(keys.locoState(id))
  const results = (await pipe.exec()) ?? []
  results.forEach(([err, value], i) => {
    if (err) return
    const parsed = parseState(value as Record<string, string>)
    if (parsed) out.set(ids[i], parsed)
  })
  return out
}
