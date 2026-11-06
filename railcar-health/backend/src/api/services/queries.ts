/**
 * Read-side queries over the projections. Reads never touch the event store
 * except for timelines; a projection may lag its events by a moment, which the
 * Ops page shows as staleness.
 * @module api/services/queries
 */
import { pool } from '../../shared/db.js'
import { alertDto, type AlertRow } from '../dto.js'

/** Alerts with their trip, owner mark, work order and hold, and the latest trend features for the bearing. */
export const ALERT_SELECT = `
  SELECT a.*, COALESCE(CASE WHEN a.status <> 'closed' THEN btl.features END, a.features) AS features,
         t.symbol, t.direction, t.status AS trip_status, c.owner_mark,
         wo.id AS work_order_id, wo.status AS work_order_status, h.status AS hold_status
    FROM alerts a
    JOIN trips t ON t.trip_id = a.trip_id
    LEFT JOIN railcars c ON c.car_id = a.car_id
    LEFT JOIN work_orders wo ON wo.alert_id = a.id
    LEFT JOIN LATERAL (SELECT status FROM car_holds h WHERE h.alert_id = a.id ORDER BY (h.status = 'released'), h.created_at DESC LIMIT 1) h ON true
    LEFT JOIN bearing_trends_latest btl ON btl.trip_id = a.trip_id AND btl.car_id = a.car_id AND btl.position = a.position AND a.kind = 'hot_bearing'`

export async function getAlertRow(id: string): Promise<ReturnType<typeof alertDto> | null> {
  const { rows } = await pool.query<AlertRow>(`${ALERT_SELECT} WHERE a.id = $1`, [id]).catch(() => ({ rows: [] as AlertRow[] }))
  return rows[0] ? alertDto(rows[0]) : null
}
