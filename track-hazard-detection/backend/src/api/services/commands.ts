/**
 * Dispatcher and inspector commands on a hazard. Each command:
 *
 *  - is idempotent by client command id: a retry after a lost response returns
 *    the stored result instead of acting twice (command_log, same transaction);
 *  - folds the hazard stream under an advisory lock and checks business rules
 *    on the current state (not on a version number, so a new evidence event
 *    does not bounce an acknowledgment);
 *  - for clear / false alarm, refuses if the hazard got *worse* since the
 *    version the person was looking at (409 HAZARD_CHANGED);
 *  - appends with optimistic concurrency, which also writes the outbox rows.
 * @module api/services/commands
 */
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { SessionUser } from '../../shared/auth.js'
import { config } from '../../shared/config.js'
import { lockKey, withTransaction, type Client } from '../../shared/db.js'
import { appendToStream, loadStream, withConcurrencyRetry } from '../../shared/event-store.js'
import { draft, type DomainEventDraft } from '../../shared/events/domain.js'
import { HttpError, notFound } from '../../shared/errors.js'
import { activeRestrictions, foldHazard, type HazardState } from '../../shared/hazard.js'
import { approachingTrains } from '../../alerting/reconcile.js'
import { SUBDIVISION_BY_ID } from '../../shared/track.js'

export const commandSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('acknowledge'), note: z.string().max(500).optional() }),
  z.object({ kind: z.literal('warn_trains') }),
  z.object({ kind: z.literal('speed_restriction'), mpFrom: z.number(), mpTo: z.number(), maxSpeedMph: z.number().int().min(0).max(60), reason: z.string().max(200).optional() }),
  z.object({ kind: z.literal('lift_restriction'), restrictionId: z.string().min(1), reason: z.string().max(200).optional() }),
  z.object({ kind: z.literal('dispatch_inspector'), inspector: z.string().min(1), etaMinutes: z.number().min(0).max(600), note: z.string().max(500).optional() }),
  z.object({ kind: z.literal('clear'), note: z.string().max(500).optional() }),
  z.object({ kind: z.literal('false_alarm'), note: z.string().max(500).optional(), cause: z.string().max(200).optional() }),
])

export const commandRequestSchema = z.object({
  commandId: z.string().uuid(),
  /** The hazard version the person was looking at. */
  seenVersion: z.number().int().nonnegative().optional(),
  command: commandSchema,
})

export type Command = z.infer<typeof commandSchema>

export interface CommandResult {
  hazard: HazardState
  appended: string[]
  replayed: boolean
}

const MATERIAL = new Set(['HazardUpgraded', 'HazardEvidenceAdded', 'HazardRiskElevated'])

async function deskOf(client: Client, subdivisionId: string): Promise<string | null> {
  const { rows } = await client.query<{ desk_id: string }>('SELECT desk_id FROM subdivisions WHERE id = $1', [subdivisionId])
  return rows[0]?.desk_id ?? null
}

function authorize(user: SessionUser, state: HazardState, desk: string | null, command: Command): void {
  if (user.role === 'admin') return
  if (user.role === 'dispatcher') {
    if (user.deskId !== desk) throw new HttpError(403, 'NOT_YOUR_TERRITORY', `This hazard is on ${SUBDIVISION_BY_ID.get(state.subdivisionId)?.name ?? state.subdivisionId}, owned by the ${desk} desk`)
    return
  }
  // Inspectors act only on hazards they were dispatched to, and only to clear them or call a false alarm.
  if (user.role === 'inspector' && (command.kind === 'clear' || command.kind === 'false_alarm') && state.inspector?.username === user.username) return
  throw new HttpError(403, 'FORBIDDEN', 'Your role cannot perform this action on this hazard')
}

async function decide(client: Client, user: SessionUser, state: HazardState, events: { type: string; streamVersion: number }[], command: Command, seenVersion?: number): Promise<DomainEventDraft[]> {
  const hazardId = state.hazardId
  if (!state.open) throw new HttpError(409, 'HAZARD_CLOSED', `Hazard ${state.code} is already ${state.responseStatus === 'false_alarm' ? 'closed as a false alarm' : 'cleared'}`)
  switch (command.kind) {
    case 'acknowledge':
      if (!state.alert) throw new HttpError(409, 'NO_ALERT', 'No alert has been issued for this hazard yet')
      if (state.alert.acknowledgedAt) return []
      return [draft('AlertAcknowledged', { hazardId, alertId: state.alert.alertId, by: user.username, note: command.note })]
    case 'warn_trains': {
      const trains = await latestTrains(client, state.subdivisionId)
      const warned = new Set(state.warnedTrains.filter((t) => !t.releasedAt).map((t) => t.trainId))
      const fresh = approachingTrains(state, trains, config.alerting).filter((t) => !warned.has(t.trainId))
      if (fresh.length === 0) throw new HttpError(409, 'NO_TRAINS', 'No unwarned trains are approaching this hazard')
      return [draft('TrainsWarned', { hazardId, trains: fresh, instruction: `Restricted speed MP ${state.mpFrom.toFixed(1)}-${state.mpTo.toFixed(1)}, prepared to stop; ${state.kind.replace('_', ' ')} reported`, automatic: false, by: user.username })]
    }
    case 'speed_restriction': {
      const sub = SUBDIVISION_BY_ID.get(state.subdivisionId)!
      const mpFrom = Math.min(command.mpFrom, command.mpTo)
      const mpTo = Math.max(command.mpFrom, command.mpTo)
      if (mpFrom < sub.startMp || mpTo > sub.endMp) throw new HttpError(422, 'OUT_OF_LIMITS', `Restriction must be within MP ${sub.startMp}-${sub.endMp}`)
      return [
        draft('SpeedRestrictionIssued', {
          hazardId,
          restrictionId: `SR-${randomUUID().slice(0, 8).toUpperCase()}`,
          subdivisionId: state.subdivisionId,
          mpFrom,
          mpTo,
          maxSpeedMph: command.maxSpeedMph,
          reason: command.reason || `${state.code} ${state.kind.replace('_', ' ')}`,
          automatic: false,
          by: user.username,
        }),
      ]
    }
    case 'lift_restriction': {
      const r = activeRestrictions(state).find((x) => x.restrictionId === command.restrictionId)
      if (!r) throw new HttpError(409, 'NOT_ACTIVE', `Restriction ${command.restrictionId} is not active on this hazard`)
      return [draft('SpeedRestrictionLifted', { hazardId, restrictionId: r.restrictionId, reason: command.reason || 'lifted by dispatcher', by: user.username })]
    }
    case 'dispatch_inspector': {
      const { rows } = await client.query<{ display_name: string }>(`SELECT display_name FROM users WHERE username = $1 AND role = 'inspector'`, [command.inspector])
      if (!rows[0]) throw new HttpError(422, 'UNKNOWN_INSPECTOR', `${command.inspector} is not a track inspector`)
      return [draft('InspectorDispatched', { hazardId, inspector: command.inspector, inspectorName: rows[0].display_name, etaMinutes: command.etaMinutes, by: user.username, note: command.note })]
    }
    case 'clear':
    case 'false_alarm': {
      if (seenVersion !== undefined) {
        const worse = events.filter((e) => e.streamVersion > seenVersion && MATERIAL.has(e.type))
        if (worse.length) throw new HttpError(409, 'HAZARD_CHANGED', `New evidence arrived since you looked (${worse.map((e) => e.type).join(', ')}). Review it before closing.`, { currentVersion: state.version })
      }
      return command.kind === 'clear'
        ? [draft('HazardCleared', { hazardId, by: user.username, note: command.note })]
        : [draft('HazardConfirmedFalseAlarm', { hazardId, by: user.username, note: command.note, cause: command.cause })]
    }
  }
}

async function latestTrains(client: Client, subdivisionId: string) {
  const { rows } = await client.query<{ train_id: string; symbol: string; milepost: number; direction: 'increasing' | 'decreasing'; speed_mph: number; occurred_at: Date }>(
    `SELECT DISTINCT ON (train_id) train_id, symbol, milepost, direction, speed_mph, occurred_at FROM train_positions
     WHERE subdivision_id = $1 AND occurred_at > now() - interval '10 minutes' ORDER BY train_id, occurred_at DESC`,
    [subdivisionId],
  )
  return rows.map((r) => ({ trainId: r.train_id, symbol: r.symbol, milepost: Number(r.milepost), direction: r.direction, speedMph: Number(r.speed_mph), occurredAt: new Date(r.occurred_at).toISOString() }))
}

export async function executeCommand(user: SessionUser, hazardId: string, commandId: string, command: Command, seenVersion?: number): Promise<CommandResult> {
  const streamId = `hazard-${hazardId}`
  return withConcurrencyRetry(() =>
    withTransaction(async (client) => {
      const prior = await client.query<{ username: string; hazard_id: string; result: { appended: string[] } }>('SELECT username, hazard_id, result FROM command_log WHERE command_id = $1', [commandId])
      if (prior.rows[0]) {
        if (prior.rows[0].hazard_id !== hazardId || prior.rows[0].username !== user.username) throw new HttpError(409, 'COMMAND_ID_REUSED', 'This command id was already used for a different command')
        const state = foldHazard(await loadStream(client, streamId))
        return { hazard: state!, appended: prior.rows[0].result.appended, replayed: true }
      }
      await client.query('SELECT pg_advisory_xact_lock($1)', [lockKey(streamId)])
      const events = await loadStream(client, streamId)
      const state = foldHazard(events)
      if (!state) throw notFound('Hazard')
      authorize(user, state, await deskOf(client, state.subdivisionId), command)
      const drafts = await decide(client, user, state, events, command, seenVersion)
      const appended = drafts.length
        ? await appendToStream(client, streamId, state.version, drafts, {
            partitionKey: state.segmentId,
            source: 'api',
            correlationId: events[0]?.correlationId,
            causationId: events.at(-1)?.eventId ?? null,
            meta: { actor: user.username, commandId, segmentId: state.segmentId, subdivisionId: state.subdivisionId },
          })
        : []
      await client.query('INSERT INTO command_log (command_id, username, hazard_id, command, result) VALUES ($1, $2, $3, $4, $5)', [
        commandId,
        user.username,
        hazardId,
        command.kind,
        { appended: appended.map((e) => e.type) },
      ])
      return { hazard: foldHazard([...events, ...appended])!, appended: appended.map((e) => e.type), replayed: false }
    }),
  )
}
