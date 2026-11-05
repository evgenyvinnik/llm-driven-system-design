/**
 * Price changes (admin edits and the daily vendor price feed). Writes the
 * price and an append-only history row in one transaction, then asks the
 * planner to look again at every running train that has not yet passed that
 * location.
 * @module api/services/prices
 */
import { pool, withTransaction } from '../../shared/db.js'
import { notFound } from '../../shared/errors.js'
import { publishEvent } from '../../shared/events.js'
import { enqueuePlan } from '../../shared/triggers.js'

export interface PricePatch {
  pricePerGal?: number
  active?: boolean
}

export async function changePrice(optionId: string, patch: PricePatch, by: string, note: string | null, at: Date): Promise<{ affectedTrains: string[] }> {
  const before = await withTransaction(async (db) => {
    const cur = await db.query<{ locationId: string; price: number; active: boolean }>(
      'SELECT location_id AS "locationId", price_per_gal::float AS price, active FROM fuel_options WHERE id = $1 FOR UPDATE',
      [optionId],
    )
    if (!cur.rows[0]) throw notFound('Fuel option')
    await db.query('UPDATE fuel_options SET price_per_gal = COALESCE($2, price_per_gal), active = COALESCE($3, active), updated_at = now() WHERE id = $1', [
      optionId,
      patch.pricePerGal ?? null,
      patch.active ?? null,
    ])
    if (patch.pricePerGal !== undefined) {
      await db.query('INSERT INTO fuel_price_history (option_id, price_per_gal, effective_at, changed_by, note) VALUES ($1, $2, $3, $4, $5)', [
        optionId,
        patch.pricePerGal,
        at,
        by,
        note,
      ])
    }
    return cur.rows[0]
  })

  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM trains
      WHERE status = 'running' AND $1 = ANY(path)
        AND (last_location IS NULL OR array_position(path, last_location) < array_position(path, $1))`,
    [before.locationId],
  )
  const delta =
    patch.pricePerGal !== undefined
      ? `${optionId} $${before.price.toFixed(2)} → $${patch.pricePerGal.toFixed(2)}`
      : `${optionId} ${patch.active ? 'reopened' : 'closed'}`
  for (const r of rows) await enqueuePlan(r.id, 'price_change', delta)
  await publishEvent({ type: 'price', id: optionId, note: delta })
  return { affectedTrains: rows.map((r) => r.id) }
}
