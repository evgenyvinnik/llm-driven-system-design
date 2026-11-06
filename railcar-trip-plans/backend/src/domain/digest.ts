/**
 * Shipper digests: many item events in, one message per shipper out.
 *
 * Items for one car collapse to one line describing where the car ended up (the latest ETA, the latest plan
 * version, delivered), not every intermediate step. ETA changes are measured against what the shipper was
 * last told, so an ETA that moved six hours and back again inside one window is not news, and a series of
 * small moves is reported once it adds up.
 * @module domain/digest
 */

export type ItemKind = 'eta_change' | 'replanned' | 'bad_order' | 'delivered'

export interface DigestItem {
  carId: string
  kind: ItemKind
  occurredAt: string
  payload: Record<string, unknown>
}

export interface LastNotified {
  p50: string | null
  planVersion: number | null
}

export interface DigestLine {
  carId: string
  kinds: ItemKind[]
  text: string
}

export interface Digest {
  lines: DigestLine[]
  carIds: string[]
  suppressed: number
  /** What each listed car was told, to remember for the next digest. */
  told: Map<string, { p50: string | null; planVersion: number | null }>
  subject: string
}

const fmt = (iso: string) => {
  const d = new Date(iso)
  return `${d.toISOString().slice(5, 10)} ${d.toISOString().slice(11, 16)}Z`
}

const hoursBetween = (a: string, b: string) => Math.round((Date.parse(a) - Date.parse(b)) / 360_000) / 10

export function buildDigest(items: DigestItem[], last: Map<string, LastNotified>, shiftThresholdMinutes: number): Digest {
  const byCar = new Map<string, DigestItem[]>()
  for (const item of [...items].sort((a, b) => (a.occurredAt < b.occurredAt ? -1 : a.occurredAt > b.occurredAt ? 1 : 0))) {
    const list = byCar.get(item.carId) ?? []
    list.push(item)
    byCar.set(item.carId, list)
  }

  const lines: DigestLine[] = []
  const told = new Map<string, { p50: string | null; planVersion: number | null }>()
  let suppressed = 0
  const counts: Record<ItemKind, number> = { eta_change: 0, replanned: 0, bad_order: 0, delivered: 0 }

  for (const [carId, list] of [...byCar.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const kinds = [...new Set(list.map((i) => i.kind))]
    const delivered = list.filter((i) => i.kind === 'delivered').at(-1)
    const replan = list.filter((i) => i.kind === 'replanned').at(-1)
    const badOrder = list.filter((i) => i.kind === 'bad_order').at(-1)
    // The newest ETA from either an ETA change or a replan outcome.
    let eta: { p10?: string; p50: string; p90: string } | null = null
    for (const i of list) {
      if (i.kind === 'eta_change') eta = { p10: i.payload.p10 as string, p50: i.payload.p50 as string, p90: i.payload.p90 as string }
      if (i.kind === 'replanned' && i.payload.etaAfter) eta = i.payload.etaAfter as { p10?: string; p50: string; p90: string }
    }
    const prev = last.get(carId) ?? { p50: null, planVersion: null }

    if (delivered) {
      lines.push({ carId, kinds, text: `${carId}: delivered ${fmt(delivered.occurredAt)}.` })
      told.set(carId, { p50: delivered.occurredAt, planVersion: prev.planVersion })
      counts.delivered++
      suppressed += list.length - 1
      continue
    }

    const parts: string[] = []
    let planVersion = prev.planVersion
    if (badOrder) {
      parts.push(`bad-ordered at ${badOrder.payload.yardId} (${badOrder.payload.defect ?? 'defect'})`)
      counts.bad_order++
    }
    if (replan) {
      const p = replan.payload
      planVersion = p.toPlanVersion as number
      parts.push(`plan v${p.fromPlanVersion} → v${p.toPlanVersion}: ${String(p.reasonText).replace(/\.$/, '')}`)
      counts.replanned++
    }
    const shift = eta && prev.p50 ? Math.round((Date.parse(eta.p50) - Date.parse(prev.p50)) / 60_000) : null
    const etaIsNews = eta !== null && (prev.p50 === null || Math.abs(shift ?? 0) >= shiftThresholdMinutes)
    if (eta && (etaIsNews || parts.length > 0)) {
      const delta = prev.p50 && shift !== null ? ` (${shift >= 0 ? '+' : ''}${hoursBetween(eta.p50, prev.p50)} h vs last update)` : ''
      parts.push(`ETA ${fmt(eta.p50)}, likely ${fmt(eta.p10 ?? eta.p50)} – ${fmt(eta.p90)}${delta}`)
      if (!replan && !badOrder) counts.eta_change++
    }
    if (parts.length === 0) {
      suppressed += list.length
      continue
    }
    lines.push({ carId, kinds, text: `${carId}: ${parts.join('; ')}.` })
    told.set(carId, { p50: eta?.p50 ?? prev.p50, planVersion })
    suppressed += list.length - 1
  }

  const bits = [
    counts.replanned ? `${counts.replanned} replanned` : '',
    counts.eta_change ? `${counts.eta_change} ETA change${counts.eta_change > 1 ? 's' : ''}` : '',
    counts.bad_order ? `${counts.bad_order} bad order${counts.bad_order > 1 ? 's' : ''}` : '',
    counts.delivered ? `${counts.delivered} delivered` : '',
  ].filter(Boolean)
  return {
    lines,
    carIds: lines.map((l) => l.carId),
    suppressed,
    told,
    subject: `${lines.length} car${lines.length === 1 ? '' : 's'} updated: ${bits.join(', ') || 'no changes'}`,
  }
}
