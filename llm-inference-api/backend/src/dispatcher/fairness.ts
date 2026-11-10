/**
 * Per-tenant fairness inside a priority class: deficit round robin (DRR) by
 * cost. Each tenant with queued work earns `quantum × weight` tokens of credit
 * per round and may dispatch requests while its credit covers their estimated
 * cost. A tenant with 500 queued requests and one with 2 therefore alternate;
 * the noisy tenant only gets the capacity nobody else is asking for.
 *
 * Costs are tokens (input + max_tokens), not request counts, so a tenant
 * sending few huge requests does not out-dispatch one sending many small ones.
 * Credit is dropped when a tenant's queue empties (idle tenants don't bank it).
 * @module dispatcher/fairness
 */

export interface QueuedHead {
  id: string
  cost: number
}

export interface TenantQueueView {
  orgId: string
  weight: number
  /** The first few queued requests, oldest first. */
  heads: QueuedHead[]
}

export interface Pick {
  id: string
  orgId: string
}

export class FairPicker {
  readonly deficits = new Map<string, number>()
  /** Tenant to resume with on the next call, and whether it already got this round's quantum. */
  private cursor: { orgId: string; credited: boolean } | null = null

  constructor(public quantum = 2048) {}

  pick(tenants: TenantQueueView[], n: number): Pick[] {
    const active = tenants.filter((t) => t.heads.length > 0).sort((a, b) => a.orgId.localeCompare(b.orgId))
    // Forget credit of tenants that have nothing queued any more.
    for (const orgId of [...this.deficits.keys()]) if (!active.some((t) => t.orgId === orgId)) this.deficits.delete(orgId)
    if (active.length === 0 || n <= 0) return []

    let start = 0
    let resumeCredited = false
    if (this.cursor) {
      const idx = active.findIndex((t) => t.orgId === this.cursor!.orgId)
      if (idx >= 0) {
        start = idx
        resumeCredited = this.cursor.credited
      } else {
        const next = active.findIndex((t) => t.orgId > this.cursor!.orgId)
        start = next >= 0 ? next : 0
      }
    }
    const pos = new Map(active.map((t) => [t.orgId, 0]))
    const picks: Pick[] = []
    const remaining = () => active.some((t) => (pos.get(t.orgId) as number) < t.heads.length)

    let first = true
    while (picks.length < n && remaining()) {
      for (let k = 0; k < active.length && picks.length < n; k++) {
        const t = active[(start + k) % active.length]
        let i = pos.get(t.orgId) as number
        if (i >= t.heads.length) continue
        const skipCredit = first && k === 0 && resumeCredited
        let deficit = (this.deficits.get(t.orgId) ?? 0) + (skipCredit ? 0 : this.quantum * t.weight)
        while (i < t.heads.length && deficit >= t.heads[i].cost && picks.length < n) {
          deficit -= t.heads[i].cost
          picks.push({ id: t.heads[i].id, orgId: t.orgId })
          i++
        }
        pos.set(t.orgId, i)
        this.deficits.set(t.orgId, i >= t.heads.length ? 0 : deficit)
        if (picks.length >= n) {
          // Stopped inside this tenant's turn: resume with it, without a fresh quantum, if it has more.
          const more = i < t.heads.length && deficit >= (t.heads[i]?.cost ?? Infinity)
          this.cursor = more ? { orgId: t.orgId, credited: true } : { orgId: active[(start + k + 1) % active.length].orgId, credited: false }
        }
      }
      first = false
    }
    if (picks.length < n) this.cursor = null
    return picks
  }
}
