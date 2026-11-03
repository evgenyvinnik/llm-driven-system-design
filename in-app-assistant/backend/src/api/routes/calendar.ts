/** Host app: calendar. */
import { Router } from 'express'
import { z } from 'zod'
import { requireAuth } from '../../shared/auth.js'
import { pool } from '../../shared/db.js'
import { asyncHandler } from '../../shared/errors.js'
import { idParam } from '../../shared/ids.js'
import { addDays, todayIn, zonedTime } from '../../shared/time.js'

export const calendarRouter = Router()
calendarRouter.use(requireAuth)

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

calendarRouter.get(
  '/events',
  asyncHandler(async (req, res) => {
    const tz = req.user!.timezone
    const from = ymd.default(todayIn(tz)).parse(req.query.from)
    const to = ymd.default(addDays(from, 6)).parse(req.query.to)
    const { rows } = await pool.query<{ id: string; title: string; starts_at: Date; ends_at: Date; location: string | null; attendees: string[]; created_by: string }>(
      `SELECT id, title, starts_at, ends_at, location, attendees, created_by FROM calendar_events
        WHERE owner_id = $1 AND starts_at < $3 AND ends_at > $2 ORDER BY starts_at`,
      [req.user!.id, zonedTime(from, '00:00', tz), zonedTime(addDays(to, 1), '00:00', tz)],
    )
    res.json({
      from,
      to,
      timezone: tz,
      events: rows.map((e) => ({ id: e.id, title: e.title, start: e.starts_at.toISOString(), end: e.ends_at.toISOString(), location: e.location, attendees: e.attendees, createdBy: e.created_by })),
    })
  }),
)

calendarRouter.delete(
  '/events/:id',
  asyncHandler(async (req, res) => {
    await pool.query('DELETE FROM calendar_events WHERE id = $1 AND owner_id = $2', [idParam(req.params.id, 'ev', 'Event'), req.user!.id])
    res.status(204).end()
  }),
)
