/**
 * Calendar tools. Structured questions ("what's on tomorrow") are API queries,
 * not vector search. Times go in as a local date and time plus a zone and are
 * converted here, because date arithmetic is exactly what models get wrong.
 * @module tools/calendar
 */
import { shortId } from '../shared/ids.js'
import { addDays, formatLocal, isValidTimeZone, zonedTime } from '../shared/time.js'
import { ToolError, type ToolContext, type ToolSpec } from './types.js'

const eventSource = (id: string, title: string, when: string) => ({ id, kind: 'event' as const, title, subtitle: when, href: `/calendar?e=${id}` })

export const searchEvents: ToolSpec = {
  name: 'search_events',
  description:
    "List events on the user's calendar between two dates (inclusive, in the user's time zone), optionally filtered by keywords in the title. For \"tomorrow\", pass tomorrow's date as both start_date and end_date. Returns event_id, title, local start and end, location and attendees.",
  inputSchema: {
    type: 'object',
    properties: {
      start_date: { type: 'string', format: 'date' },
      end_date: { type: 'string', format: 'date', description: 'Defaults to start_date' },
      query: { type: 'string', description: 'Optional keywords matched against event titles' },
    },
    required: ['start_date'],
    additionalProperties: false,
  },
  apps: ['mail', 'docs', 'calendar'],
  execution: 'server',
  effect: 'read',
  reversible: true,
  timeoutMs: 3000,
  statusLabel: () => 'Checking your calendar…',
  async run(args, ctx) {
    const start = String(args.start_date)
    const end = String(args.end_date ?? start)
    if (end < start) throw new ToolError('end_date is before start_date. Swap them or pass a single date as start_date.')
    const from = zonedTime(start, '00:00', ctx.timezone)
    const to = zonedTime(addDays(end, 1), '00:00', ctx.timezone)
    const values: unknown[] = [ctx.userId, from, to]
    let filter = ''
    if (typeof args.query === 'string' && args.query.trim()) {
      values.push(`%${args.query.trim()}%`)
      filter = `AND title ILIKE $4`
    }
    const { rows } = await ctx.db.query<{ id: string; title: string; starts_at: Date; ends_at: Date; location: string | null; attendees: string[] }>(
      `SELECT id, title, starts_at, ends_at, location, attendees FROM calendar_events
        WHERE owner_id = $1 AND starts_at < $3 AND ends_at > $2 ${filter} ORDER BY starts_at LIMIT 50`,
      values,
    )
    const events = rows.map((r) => ({
      event_id: r.id,
      title: r.title,
      start: formatLocal(r.starts_at, ctx.timezone),
      end: formatLocal(r.ends_at, ctx.timezone),
      ...(r.location ? { location: r.location } : {}),
      attendees: r.attendees,
    }))
    return {
      content: { range: `${start} to ${end} (${ctx.timezone})`, events },
      sources: events.map((e) => eventSource(e.event_id, e.title, e.start)),
      summary: `${events.length} event${events.length === 1 ? '' : 's'} from ${start} to ${end}`,
    }
  },
}

function external(attendees: string[], ctx: ToolContext) {
  return attendees.filter((a) => !a.toLowerCase().endsWith(`@${ctx.orgDomain}`))
}

export const createEvent: ToolSpec = {
  name: 'create_event',
  description:
    "Create an event on the user's calendar. Pass the local date and start time and the duration; the tool converts to the right instant for the time zone (the user's own unless you pass one). With attendees, invitations go out, so the user confirms first. Returns the event_id and the start and end as the user will see them.",
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', minLength: 1, maxLength: 200 },
      date: { type: 'string', format: 'date' },
      start_time: { type: 'string', pattern: '^([01][0-9]|2[0-3]):[0-5][0-9]$', description: '24-hour local time, e.g. "14:30"' },
      duration_minutes: { type: 'integer', minimum: 5, maximum: 600, default: 30 },
      attendees: { type: 'array', items: { type: 'string', format: 'email' }, maxItems: 50 },
      location: { type: 'string', maxLength: 200 },
      timezone: { type: 'string', description: 'IANA zone such as "Europe/Lisbon"; defaults to the user\'s' },
    },
    required: ['title', 'date', 'start_time'],
    additionalProperties: false,
  },
  apps: ['mail', 'calendar'],
  execution: 'server',
  effect: (args) => ((args.attendees as string[] | undefined)?.length ? 'send' : 'write'),
  reversible: (args) => !(args.attendees as string[] | undefined)?.length,
  timeoutMs: 3000,
  statusLabel: () => 'Creating the event…',
  async inspect(args, ctx) {
    const attendees = (args.attendees as string[]) ?? []
    return {
      externalRecipients: external(attendees, ctx),
      title: `Create "${args.title}" on ${args.date} at ${args.start_time}${attendees.length ? ` and invite ${attendees.join(', ')}` : ''}`,
      preview: { kind: 'event', title: args.title, date: args.date, start_time: args.start_time, duration_minutes: args.duration_minutes ?? 30, attendees, timezone: args.timezone ?? ctx.timezone },
    }
  },
  async run(args, ctx) {
    const zone = String(args.timezone ?? ctx.timezone)
    if (!isValidTimeZone(zone)) throw new ToolError(`"${zone}" is not a time zone. Use an IANA name like "Europe/Lisbon", or leave timezone out.`)
    const starts = zonedTime(String(args.date), String(args.start_time), zone)
    const ends = new Date(starts.getTime() + Number(args.duration_minutes ?? 30) * 60_000)
    const id = shortId('ev')
    const attendees = (args.attendees as string[]) ?? []
    await ctx.db.query(
      `INSERT INTO calendar_events (id, owner_id, title, starts_at, ends_at, location, attendees, created_by, turn_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'assistant', $8)`,
      [id, ctx.userId, args.title, starts, ends, args.location ?? null, attendees, ctx.turnId],
    )
    const start = formatLocal(starts, ctx.timezone)
    return {
      content: { event_id: id, title: args.title, start, end: formatLocal(ends, ctx.timezone), invitations_sent_to: attendees },
      sources: [eventSource(id, String(args.title), start)],
      summary: `Event ${id} on ${start}`,
    }
  },
}
