/**
 * Runs the eval tasks through the real orchestrator, in process, as Alice.
 * Confirmations and client tools are answered by the harness. Reports how
 * often the right tool came first, how often arguments were valid, calls and
 * tokens per task and the success rate, stores the run for the admin page,
 * and removes the drafts, events and suggestions the run created.
 *
 *   npm run eval            (needs the stack and seed data; the mock model must be running)
 */
process.env.SERVICE_NAME ??= 'eval'
process.env.LOG_LEVEL ??= 'warn'
const { randomUUID } = await import('node:crypto')
const { config } = await import('../shared/config.js')
const { pool } = await import('../shared/db.js')
const { redis } = await import('../shared/cache.js')
const { startDrive } = await import('../orchestrator/run-turn.js')
const { resolveAction, submitClientResult } = await import('../orchestrator/resume.js')
const { TASKS } = await import('./tasks.js')

const USER = 'u_alice'
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

interface Result {
  task: string
  passed: boolean
  failures: string[]
  tools: string[]
  firstToolCorrect: boolean
  invalidArgs: number
  toolCalls: number
  steps: number
  inputTokens: number
  outputTokens: number
  ms: number
}

async function runTask(task: (typeof TASKS)[number]): Promise<Result> {
  const conversationId = randomUUID()
  const turnId = randomUUID()
  await pool.query('INSERT INTO conversations (id, user_id, app, title, is_eval) VALUES ($1, $2, $3, $4, true)', [conversationId, USER, task.app, task.name])
  await pool.query(
    `INSERT INTO turns (id, conversation_id, user_id, seq, idempotency_key, request_hash, user_text, client_context, status, lease_owner, lease_expires_at)
     VALUES ($1, $2, $3, 1, $4, 'eval', $5, $6, 'running', $7, now() + interval '30 seconds')`,
    [turnId, conversationId, USER, `eval-${turnId}`, task.text, JSON.stringify(task.openDocument ? { openDocument: task.openDocument } : {}), config.instanceId],
  )
  const started = Date.now()
  void startDrive(turnId)
  let turn: { status: string; batch: { waiting?: { callId: string; kind: string; actionId?: string }; calls: { id: string; name: string }[] } | null; final_text: string | null; citations: { id: string; verified: boolean }[]; steps: number; input_tokens: number; output_tokens: number }
  while (true) {
    await sleep(100)
    turn = (await pool.query('SELECT status, batch, final_text, citations, steps, input_tokens, output_tokens FROM turns WHERE id = $1', [turnId])).rows[0]
    if (['completed', 'failed', 'cancelled'].includes(turn.status)) break
    const waiting = turn.batch?.waiting
    if (turn.status === 'waiting_confirmation' && waiting?.actionId) await resolveAction(waiting.actionId, USER, task.confirm === 'approve')
    if (turn.status === 'waiting_client' && waiting) {
      const name = turn.batch!.calls.find((c) => c.id === waiting.callId)?.name ?? ''
      const output = task.clientResults?.[name]
      await submitClientResult(turnId, USER, output ? { callId: waiting.callId, output } : { callId: waiting.callId, error: `${name} is not available in the eval harness` })
    }
    if (Date.now() - started > 60_000) throw new Error(`${task.name} timed out`)
  }
  const { rows: steps } = await pool.query<{ name: string; detail: { ok?: boolean; error?: unknown } }>(
    `SELECT name, detail FROM turn_steps WHERE turn_id = $1 AND kind = 'tool_call' ORDER BY id`,
    [turnId],
  )
  const ok = steps.filter((s) => s.detail.ok !== false).map((s) => s.name)
  const attempted = steps.map((s) => s.name)
  const invalidArgs = steps.filter((s) => Array.isArray(s.detail.error)).length
  const failures: string[] = []
  if (turn.status !== 'completed') failures.push(`status ${turn.status}`)
  let cursor = 0
  for (const expected of task.expectTools) {
    const at = attempted.indexOf(expected, cursor)
    if (at === -1) failures.push(`never called ${expected}`)
    else cursor = at + 1
  }
  for (const name of task.forbidTools ?? []) if (ok.includes(name)) failures.push(`ran ${name}`)
  const text = turn.final_text ?? ''
  for (const re of task.expectText ?? []) if (!re.test(text)) failures.push(`answer missing ${re}`)
  for (const re of task.forbidText ?? []) if (re.test(text)) failures.push(`answer contains ${re}`)
  const cited = (turn.citations ?? []).filter((c) => c.verified).map((c) => c.id)
  for (const id of task.expectCitations ?? []) if (!cited.includes(id)) failures.push(`did not cite ${id}`)
  for (const id of task.forbidCitations ?? []) if (cited.includes(id)) failures.push(`cited ${id}`)
  if ((turn.citations ?? []).some((c) => !c.verified)) failures.push('unverified citation')
  return {
    task: task.name,
    passed: failures.length === 0,
    failures,
    tools: attempted,
    firstToolCorrect: attempted[0] === task.expectTools[0],
    invalidArgs,
    toolCalls: attempted.length,
    steps: turn.steps,
    inputTokens: turn.input_tokens,
    outputTokens: turn.output_tokens,
    ms: Date.now() - started,
  }
}

async function cleanup(): Promise<void> {
  const evalTurns = `SELECT t.id FROM turns t JOIN conversations c ON c.id = t.conversation_id WHERE c.is_eval`
  await pool.query(`DELETE FROM mail_drafts WHERE turn_id IN (${evalTurns})`)
  await pool.query(`DELETE FROM calendar_events WHERE turn_id IN (${evalTurns})`)
  await pool.query(`DELETE FROM doc_paragraphs WHERE suggestion = 'insert' AND suggestion_turn_id IN (${evalTurns})`)
  await pool.query(`UPDATE doc_paragraphs SET suggestion = NULL, suggested_text = NULL, suggested_by = NULL, suggestion_turn_id = NULL WHERE suggestion_turn_id IN (${evalTurns})`)
  await pool.query('DELETE FROM conversations WHERE is_eval')
}

const results: Result[] = []
try {
  await pool.query('UPDATE user_settings SET prefetch = false, max_steps = 15, block_external_after_untrusted = false, confirm_writes = false WHERE user_id = $1', [USER])
  for (const task of TASKS) {
    const result = await runTask(task)
    results.push(result)
    console.log(`${result.passed ? 'PASS' : 'FAIL'}  ${task.name.padEnd(38)} ${result.tools.join(' → ')}${result.failures.length ? `\n      ${result.failures.join('; ')}` : ''}`)
  }
  const n = results.length
  const summary = {
    tasks: n,
    passed: results.filter((r) => r.passed).length,
    successRate: results.filter((r) => r.passed).length / n,
    firstToolCorrectRate: results.filter((r) => r.firstToolCorrect).length / n,
    validArgsRate: 1 - results.reduce((a, r) => a + r.invalidArgs, 0) / Math.max(1, results.reduce((a, r) => a + r.toolCalls, 0)),
    avgToolCalls: results.reduce((a, r) => a + r.toolCalls, 0) / n,
    avgTokens: results.reduce((a, r) => a + r.inputTokens + r.outputTokens, 0) / n,
    avgMs: results.reduce((a, r) => a + r.ms, 0) / n,
  }
  await pool.query('INSERT INTO eval_runs (model, summary, results) VALUES ($1, $2, $3)', [config.model.primary, JSON.stringify(summary), JSON.stringify(results)])
  console.log(`\n${summary.passed}/${n} passed · right first tool ${(summary.firstToolCorrectRate * 100).toFixed(0)}% · valid args ${(summary.validArgsRate * 100).toFixed(0)}% · ${summary.avgToolCalls.toFixed(1)} calls/task · ${Math.round(summary.avgTokens)} tokens/task`)
  if (summary.passed < n) process.exitCode = 1
} finally {
  await cleanup()
  await pool.query('UPDATE user_settings SET prefetch = true WHERE user_id = $1', [USER])
  await sleep(200)
  await pool.end()
  redis.disconnect()
}
