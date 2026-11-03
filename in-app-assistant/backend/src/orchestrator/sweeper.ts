/**
 * Every API instance runs this sweep. Each waiting state has a defined
 * outcome when nobody answers, and a running turn whose owner stopped
 * heartbeating is taken over and resumed from its last checkpoint (tool
 * writes are idempotent, so nothing is done twice):
 *
 * - running, lease expired      → claim and resume here
 * - waiting_client > 30 s        → the call fails with "the browser didn't respond"; resume
 * - waiting_confirmation expired → the action is left undone and the turn ends saying so
 * @module orchestrator/sweeper
 */
import { createRedisConnection } from '../shared/cache.js'
import { config } from '../shared/config.js'
import { pool, withTransaction } from '../shared/db.js'
import { childLogger } from '../shared/logger.js'
import { turnsFinished } from '../shared/metrics.js'
import { emit, TURN_CANCEL_CHANNEL } from './events.js'
import { abortLocal, startDrive } from './run-turn.js'
import { claimTurn, finishTurn, recordStep, type Turn } from './turn-store.js'

const log = childLogger('sweeper')

export async function sweepOnce(): Promise<{ recovered: number; clientTimeouts: number; expired: number }> {
  let recovered = 0
  let clientTimeouts = 0
  let expired = 0

  const { rows: stale } = await pool.query<{ id: string }>(
    `SELECT id FROM turns WHERE status = 'running' AND lease_expires_at < now() ORDER BY lease_expires_at LIMIT 10`,
  )
  for (const { id } of stale) {
    const turn = await claimTurn(id, ['running'])
    if (!turn) continue
    recovered++
    log.warn({ turnId: id }, 'took over a turn whose owner stopped responding')
    await emit(id, 'notice', { kind: 'recovered', message: 'Picked this up again after a server stopped responding' })
    await recordStep(id, { step: turn.steps, kind: 'notice', name: 'recovered', detail: { by: config.instanceId } })
    void startDrive(id)
  }

  const { rows: waitingClient } = await pool.query<{ id: string }>(
    `SELECT id FROM turns WHERE status = 'waiting_client' AND waiting_since < now() - make_interval(secs => $1) LIMIT 10`,
    [config.turn.clientToolTimeoutSeconds],
  )
  for (const { id } of waitingClient) {
    const claimed = await withTransaction(async (client) => {
      const { rows } = await client.query<Turn>(`SELECT * FROM turns WHERE id = $1 AND status = 'waiting_client' FOR UPDATE SKIP LOCKED`, [id])
      const turn = rows[0]
      if (!turn?.batch?.waiting) return null
      const callId = turn.batch.waiting.callId
      turn.batch.results[callId] = {
        content: `The browser didn't return a result within ${config.turn.clientToolTimeoutSeconds} seconds, so this tool didn't run. Continue without it.`,
        isError: true,
      }
      delete turn.batch.waiting
      await client.query(
        `UPDATE turns SET batch = $2, status = 'running', lease_owner = $3, lease_expires_at = now() + make_interval(secs => $4), waiting_since = NULL
          WHERE id = $1`,
        [id, JSON.stringify(turn.batch), config.instanceId, config.turn.leaseSeconds],
      )
      return callId
    })
    if (!claimed) continue
    clientTimeouts++
    await emit(id, 'tool.result', { callId: claimed, name: 'client_tool', ok: false, summary: 'The browser did not respond', error: 'timeout' })
    void startDrive(id)
  }

  const { rows: overdue } = await pool.query<{ id: string; turn_id: string; preview: { title?: string } }>(
    `SELECT pa.id, pa.turn_id, pa.preview FROM pending_actions pa JOIN turns t ON t.id = pa.turn_id
      WHERE pa.status = 'pending' AND pa.expires_at < now() AND t.status = 'waiting_confirmation' LIMIT 10`,
  )
  for (const action of overdue) {
    const { rowCount } = await pool.query(`UPDATE pending_actions SET status = 'expired', decided_at = now() WHERE id = $1 AND status = 'pending'`, [action.id])
    if (!rowCount) continue
    // An unanswered confirmation ends the turn with the action left undone, rather than guessing.
    const finalText = `I didn't hear back about "${action.preview?.title ?? 'the action'}", so I left it undone. Ask again whenever you're ready.`
    const done = await finishTurn(action.turn_id, { status: 'completed', finalText, citations: [], activeMs: 0 }, {}, null)
    if (!done) continue
    expired++
    turnsFinished.inc({ app: 'unknown', status: 'completed' })
    await emit(action.turn_id, 'action.resolved', { actionId: action.id, status: 'expired' })
    await emit(action.turn_id, 'turn.end', { status: 'completed', finalText, citations: [], expired: true })
  }
  return { recovered, clientTimeouts, expired }
}

export function startSweeper(): () => void {
  const timer = setInterval(() => {
    sweepOnce().catch((err) => log.error({ err }, 'sweep failed'))
  }, config.turn.sweepIntervalMs)
  // Cancels for turns running on this instance arrive over pub/sub.
  const subscriber = createRedisConnection('cancel-subscriber')
  void subscriber.subscribe(TURN_CANCEL_CHANNEL)
  subscriber.on('message', (_channel, turnId: string) => abortLocal(turnId))
  return () => {
    clearInterval(timer)
    void subscriber.quit()
  }
}
