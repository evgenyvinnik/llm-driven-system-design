/**
 * Resuming a suspended turn: a client tool result, a confirmation decision,
 * or a cancel. Any API instance can handle these, because the turn's state
 * is in PostgreSQL: the handler records the answer, claims the turn with a
 * conditional update (so a double-click or two tabs can't resume it twice),
 * and runs it here.
 * @module orchestrator/resume
 */
import { redis } from '../shared/cache.js'
import { config } from '../shared/config.js'
import { pool, withTransaction } from '../shared/db.js'
import { HttpError } from '../shared/errors.js'
import { turnsFinished } from '../shared/metrics.js'
import { shrink } from '../tools/shrink.js'
import { emit, TURN_CANCEL_CHANNEL } from './events.js'
import { abortLocal, startDrive } from './run-turn.js'
import { finishTurn, recordStep, type Batch, type Turn } from './turn-store.js'

async function lockTurn(client: { query: typeof pool.query }, turnId: string, userId: string): Promise<Turn> {
  const { rows } = await client.query<Turn>('SELECT * FROM turns WHERE id = $1 FOR UPDATE', [turnId])
  const turn = rows[0]
  if (!turn || turn.user_id !== userId) throw new HttpError(404, 'NOT_FOUND', 'Turn not found')
  return turn
}

async function claimWithBatch(client: { query: typeof pool.query }, turnId: string, batch: Batch): Promise<void> {
  await client.query(
    `UPDATE turns SET batch = $2, status = 'running', lease_owner = $3, lease_expires_at = now() + make_interval(secs => $4),
            waiting_since = NULL, updated_at = now()
      WHERE id = $1`,
    [turnId, JSON.stringify(batch), config.instanceId, config.turn.leaseSeconds],
  )
}

export async function submitClientResult(
  turnId: string,
  userId: string,
  body: { callId: string; output?: Record<string, unknown>; error?: string },
): Promise<void> {
  const summary = await withTransaction(async (client) => {
    const turn = await lockTurn(client, turnId, userId)
    const batch = turn.batch
    if (turn.status !== 'waiting_client' || !batch?.waiting || batch.waiting.callId !== body.callId) {
      // Already answered (a retried POST) or timed out: idempotent no-op.
      if (batch?.results[body.callId] || turn.status !== 'waiting_client') return null
      throw new HttpError(409, 'NOT_WAITING', 'This turn is not waiting for that tool result')
    }
    const content = body.error ? body.error : JSON.stringify(shrink(body.output ?? {}, config.turn.toolResultMaxTokens).content)
    batch.results[body.callId] = { content, isError: !!body.error }
    delete batch.waiting
    await claimWithBatch(client, turnId, batch)
    return { name: batch.calls.find((c) => c.id === body.callId)?.name ?? 'client_tool', error: body.error }
  })
  if (!summary) return
  await emit(turnId, 'tool.result', { callId: body.callId, name: summary.name, ok: !summary.error, summary: summary.error ? 'Failed in the browser' : 'Done in the browser', error: summary.error })
  await recordStep(turnId, { step: 0, kind: 'tool_call', name: summary.name, detail: { callId: body.callId, ok: !summary.error, executedBy: 'browser', error: summary.error } })
  void startDrive(turnId)
}

export async function resolveAction(actionId: string, userId: string, approve: boolean): Promise<{ status: string; turnId: string }> {
  const result = await withTransaction(async (client) => {
    const { rows } = await client.query<{ id: string; turn_id: string; call_id: string; status: string; tool: string }>(
      'SELECT id, turn_id, call_id, status, tool FROM pending_actions WHERE id = $1 FOR UPDATE',
      [actionId],
    )
    const action = rows[0]
    if (!action) throw new HttpError(404, 'NOT_FOUND', 'Action not found')
    const turn = await lockTurn(client, action.turn_id, userId)
    const decided = approve ? 'approved' : 'declined'
    if (action.status !== 'pending') {
      // The same decision twice is a retry; a different one is a conflict.
      if (action.status === decided) return { status: action.status, turnId: action.turn_id, resumed: false, tool: action.tool }
      throw new HttpError(409, 'ALREADY_DECIDED', `This action was already ${action.status}`)
    }
    if (turn.status !== 'waiting_confirmation' || turn.batch?.waiting?.actionId !== actionId) {
      throw new HttpError(409, 'NOT_WAITING', 'This turn is no longer waiting for that confirmation')
    }
    await client.query('UPDATE pending_actions SET status = $2, decided_at = now() WHERE id = $1', [actionId, decided])
    const batch = turn.batch!
    if (approve) batch.approved.push(action.call_id)
    else batch.results[action.call_id] = { content: 'The user declined this action.', isError: true }
    delete batch.waiting
    await claimWithBatch(client, turn.id, batch)
    return { status: decided, turnId: turn.id, resumed: true, tool: action.tool }
  })
  if (result.resumed) {
    await emit(result.turnId, 'action.resolved', { actionId, status: result.status })
    await recordStep(result.turnId, { step: 0, kind: 'policy', name: result.tool, detail: { actionId, userDecision: result.status } })
    void startDrive(result.turnId)
  }
  return { status: result.status, turnId: result.turnId }
}

/**
 * Stop: a waiting turn is cancelled right here; a running one is flagged and
 * the instance running it is told to abort its model stream. A write already
 * in progress finishes, and the state is saved before the turn ends.
 */
export async function cancelTurn(turnId: string, userId: string): Promise<string> {
  const { rows } = await pool.query<{ status: string }>(
    `UPDATE turns SET cancel_requested = true, updated_at = now()
      WHERE id = $1 AND user_id = $2 RETURNING status`,
    [turnId, userId],
  )
  if (!rows[0]) throw new HttpError(404, 'NOT_FOUND', 'Turn not found')
  const status = rows[0].status
  if (status === 'waiting_client' || status === 'waiting_confirmation') {
    const done = await finishTurn(turnId, { status: 'cancelled', finalText: null, citations: [], activeMs: 0 }, {}, null)
    if (done) {
      await pool.query(`UPDATE pending_actions SET status = 'expired', decided_at = now() WHERE turn_id = $1 AND status = 'pending'`, [turnId])
      turnsFinished.inc({ app: 'unknown', status: 'cancelled' })
      await emit(turnId, 'turn.end', { status: 'cancelled', finalText: null })
    }
    return 'cancelled'
  }
  if (status === 'running' && !abortLocal(turnId)) await redis.publish(TURN_CANCEL_CHANNEL, turnId)
  return status
}
