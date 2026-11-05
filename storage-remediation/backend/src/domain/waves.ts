/**
 * Wave planning for a remediation campaign.
 *
 * Order: non-production ring before production; inside each ring a canary
 * wave first, spread across as many subscriptions as possible, then waves
 * that grow by `growthFactor` up to `maxWaveSize`. Inside a ring, quieter
 * accounts go first: blast radius, not security risk, decides rollout order.
 * Risk decides which campaign runs first and who gets chased first.
 * @module domain/waves
 */
import type { EvidenceClass, Ring } from './types.js'

export interface PlanCandidate {
  accountId: string
  subscriptionId: string
  ring: Ring
  evidenceClass: EvidenceClass | null
  exempt: boolean
  /** Requests per minute; a proxy for how many people a mistake would hurt. */
  traffic: number
  riskScore: number
}

export interface WaveConfig {
  canaryPercent: number
  growthFactor: number
  maxWaveSize: number
  includeClasses: EvidenceClass[]
}

export interface PlannedWave {
  waveNo: number
  ring: Ring
  label: string
  accountIds: string[]
}

export interface WavePlan {
  waves: PlannedWave[]
  excluded: { accountId: string; reason: string }[]
}

export const DEFAULT_WAVES: WaveConfig = { canaryPercent: 5, growthFactor: 4, maxWaveSize: 400, includeClasses: ['safe_to_fix'] }

/** Round-robin across subscriptions so a canary touches many subscriptions lightly. */
function spreadAcrossSubscriptions(sorted: PlanCandidate[], count: number): PlanCandidate[] {
  const bySub = new Map<string, PlanCandidate[]>()
  for (const c of sorted) {
    const list = bySub.get(c.subscriptionId) ?? []
    list.push(c)
    bySub.set(c.subscriptionId, list)
  }
  const queues = [...bySub.values()]
  const picked: PlanCandidate[] = []
  while (picked.length < count) {
    let progressed = false
    for (const q of queues) {
      const next = q.shift()
      if (next) {
        picked.push(next)
        progressed = true
        if (picked.length === count) break
      }
    }
    if (!progressed) break
  }
  return picked
}

function planRing(candidates: PlanCandidate[], ring: Ring, cfg: WaveConfig, firstWaveNo: number): PlannedWave[] {
  if (candidates.length === 0) return []
  const sorted = [...candidates].sort((a, b) => a.traffic - b.traffic || a.accountId.localeCompare(b.accountId))
  const canarySize = Math.max(1, Math.min(cfg.maxWaveSize, Math.ceil((sorted.length * cfg.canaryPercent) / 100)))
  const canary = spreadAcrossSubscriptions(sorted, canarySize)
  const canaryIds = new Set(canary.map((c) => c.accountId))
  const rest = sorted.filter((c) => !canaryIds.has(c.accountId))
  const waves: PlannedWave[] = [{ waveNo: firstWaveNo, ring, label: `${ring} canary`, accountIds: canary.map((c) => c.accountId) }]
  let size = canarySize
  let offset = 0
  while (offset < rest.length) {
    size = Math.min(cfg.maxWaveSize, Math.max(size + 1, Math.ceil(size * cfg.growthFactor)))
    const slice = rest.slice(offset, offset + size)
    offset += slice.length
    waves.push({ waveNo: firstWaveNo + waves.length, ring, label: `${ring} wave ${waves.length + 1}`, accountIds: slice.map((c) => c.accountId) })
  }
  return waves
}

export function planWaves(candidates: PlanCandidate[], cfg: WaveConfig = DEFAULT_WAVES): WavePlan {
  const excluded: WavePlan['excluded'] = []
  const eligible: PlanCandidate[] = []
  const seen = new Set<string>()
  for (const c of candidates) {
    if (seen.has(c.accountId)) continue
    seen.add(c.accountId)
    if (c.exempt) excluded.push({ accountId: c.accountId, reason: 'exception' })
    else if (!c.evidenceClass) excluded.push({ accountId: c.accountId, reason: 'no_evidence_yet' })
    else if (!cfg.includeClasses.includes(c.evidenceClass)) excluded.push({ accountId: c.accountId, reason: c.evidenceClass })
    else eligible.push(c)
  }
  const nonprod = planRing(eligible.filter((c) => c.ring === 'nonprod'), 'nonprod', cfg, 1)
  const prod = planRing(eligible.filter((c) => c.ring === 'prod'), 'prod', cfg, nonprod.length + 1)
  return { waves: [...nonprod, ...prod], excluded }
}
