/**
 * Tool service: executes server tools with the user's identity taken from an
 * on-behalf-of token, a timeout, and an idempotency key for writes.
 *
 * Writes run in one transaction with their tool_executions row. If the
 * orchestrator crashes after the write and the turn resumes, the same
 * "<turn>:<call>" key returns the stored result instead of writing twice.
 * @module tools/service
 */
import { pool, withTransaction } from '../shared/db.js'
import { verifyOboToken } from '../shared/obo.js'
import { principalsFor } from '../retrieval/principals.js'
import { effectOf, ToolError, type ToolContext, type ToolOutput, type ToolSpec } from './types.js'

export interface ExecuteRequest {
  tool: ToolSpec
  args: Record<string, unknown>
  callId: string
  oboToken: string
  idempotencyKey: string
}

export type ExecuteResult =
  | { ok: true; output: ToolOutput; replayed: boolean }
  | { ok: false; error: string }

const domainCache = new Map<string, string>()

async function orgDomain(orgId: string): Promise<string> {
  if (!domainCache.has(orgId)) {
    const { rows } = await pool.query<{ domain: string }>('SELECT domain FROM orgs WHERE id = $1', [orgId])
    domainCache.set(orgId, rows[0]?.domain ?? '')
  }
  return domainCache.get(orgId)!
}

/** Builds the context a tool runs with. Identity comes only from the verified token. */
export async function contextFor(oboToken: string, callId: string): Promise<ToolContext> {
  const claims = verifyOboToken(oboToken)
  return {
    userId: claims.sub,
    orgId: claims.org,
    email: claims.email,
    timezone: claims.tz,
    turnId: claims.turn,
    callId,
    principals: await principalsFor(pool, claims.sub, claims.org),
    orgDomain: await orgDomain(claims.org),
    db: pool,
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, name: string): Promise<T> {
  let timer: NodeJS.Timeout
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ToolError(`${name} timed out after ${ms} ms. Try again, or narrow the request.`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

export async function executeTool(req: ExecuteRequest): Promise<ExecuteResult> {
  const { tool, args } = req
  if (!tool.run) return { ok: false, error: `${tool.name} runs in the browser, not on the server.` }
  try {
    const ctx = await contextFor(req.oboToken, req.callId)
    if (effectOf(tool, args) === 'read') {
      return { ok: true, output: await withTimeout(tool.run(args, ctx), tool.timeoutMs, tool.name), replayed: false }
    }
    return await withTransaction(async (client) => {
      // The database enforces the timeout for writes, so a slow write is rolled back rather than left running.
      await client.query(`SET LOCAL statement_timeout = ${Math.max(100, Math.floor(tool.timeoutMs))}`)
      const claimed = await client.query(
        `INSERT INTO tool_executions (idempotency_key, turn_id, call_id, tool) VALUES ($1, $2, $3, $4)
         ON CONFLICT (idempotency_key) DO NOTHING RETURNING idempotency_key`,
        [req.idempotencyKey, ctx.turnId, req.callId, tool.name],
      )
      if (!claimed.rowCount) {
        const { rows } = await client.query<{ result: ToolOutput }>('SELECT result FROM tool_executions WHERE idempotency_key = $1', [
          req.idempotencyKey,
        ])
        return { ok: true as const, output: rows[0].result, replayed: true }
      }
      const output = await tool.run!(args, { ...ctx, db: client })
      await client.query('UPDATE tool_executions SET result = $2 WHERE idempotency_key = $1', [req.idempotencyKey, output])
      return { ok: true as const, output, replayed: false }
    })
  } catch (err) {
    if (err instanceof ToolError) return { ok: false, error: err.message }
    if ((err as { code?: string }).code === '57014') return { ok: false, error: `${tool.name} timed out. Nothing was changed; try again.` }
    throw err
  }
}
