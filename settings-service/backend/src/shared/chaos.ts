/**
 * Dev chaos switch: drop the response of the next N PATCHes after they commit.
 * An armed count, not a rate, so a demo or test triggers exactly one lost
 * response on demand. Kept in Valkey (per user) so it works whichever API
 * instance receives the PATCH.
 * @module shared/chaos
 */
import { keys, redis } from './cache.js'

const TAKE = `
local v = tonumber(redis.call('GET', KEYS[1]) or '0')
if v > 0 then
  redis.call('DECR', KEYS[1])
  return 1
end
return 0
`

export interface ChaosState {
  dropNextPatchResponses: number
}

export async function getChaos(userId: string): Promise<ChaosState> {
  const raw = await redis.get(keys.chaosDrop(userId))
  return { dropNextPatchResponses: Math.max(0, Number(raw ?? 0) || 0) }
}

export async function armChaos(userId: string, state: ChaosState): Promise<ChaosState> {
  if (state.dropNextPatchResponses <= 0) await redis.del(keys.chaosDrop(userId))
  else await redis.set(keys.chaosDrop(userId), String(state.dropNextPatchResponses), 'EX', 3600)
  return getChaos(userId)
}

/** Atomically consumes one armed drop. True means: commit, then destroy the socket instead of responding. */
export async function takeDrop(userId: string): Promise<boolean> {
  const taken = await redis.eval(TAKE, 1, keys.chaosDrop(userId))
  return taken === 1
}
