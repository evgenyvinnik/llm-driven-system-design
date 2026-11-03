/**
 * Response shapes. Rows are never returned directly, so the database schema
 * isn't the public contract and the compiler checks every translation.
 */
import { pool } from '../../shared/db.js'
import type { Turn } from '../../orchestrator/turn-store.js'

export interface ActivityItem {
  kind: 'tool' | 'notice' | 'action'
  name: string
  summary: string
  ok: boolean
}

export interface PendingActionDto {
  actionId: string
  callId: string
  tool: string
  title: string
  preview: Record<string, unknown>
  reason: string
  tainted: boolean
  expiresAt: string
  status: string
}

export async function pendingActionFor(turnId: string): Promise<PendingActionDto | null> {
  const { rows } = await pool.query<{ id: string; call_id: string; tool: string; preview: Record<string, unknown>; reason: string; tainted: boolean; expires_at: Date; status: string }>(
    `SELECT id, call_id, tool, preview, reason, tainted, expires_at, status FROM pending_actions WHERE turn_id = $1 AND status = 'pending' ORDER BY created_at DESC LIMIT 1`,
    [turnId],
  )
  const row = rows[0]
  if (!row) return null
  const { title, ...preview } = row.preview as { title?: string }
  return { actionId: row.id, callId: row.call_id, tool: row.tool, title: title ?? row.tool, preview, reason: row.reason, tainted: row.tainted, expiresAt: row.expires_at.toISOString(), status: row.status }
}

async function activityFor(turnId: string): Promise<ActivityItem[]> {
  const { rows } = await pool.query<{ kind: string; name: string | null; detail: Record<string, unknown> }>(
    `SELECT kind, name, detail FROM turn_steps WHERE turn_id = $1 AND kind IN ('tool_call', 'notice', 'prefetch', 'policy') ORDER BY id`,
    [turnId],
  )
  const items: ActivityItem[] = []
  for (const r of rows) {
    if (r.kind === 'tool_call') items.push({ kind: 'tool', name: r.name ?? 'tool', summary: String(r.detail.summary ?? r.detail.error ?? ''), ok: r.detail.ok !== false })
    else if (r.kind === 'notice') items.push({ kind: 'notice', name: r.name ?? 'notice', summary: String(r.detail.message ?? ''), ok: true })
    else if (r.kind === 'prefetch' && r.name === 'retrieved') items.push({ kind: 'tool', name: 'prefetch', summary: `Found ${(r.detail.passages as unknown[])?.length ?? 0} related items before asking the model`, ok: true })
    else if (r.kind === 'policy' && r.detail.userDecision) items.push({ kind: 'action', name: r.name ?? 'action', summary: `You ${r.detail.userDecision} this action`, ok: r.detail.userDecision === 'approved' })
  }
  return items
}

export async function turnDto(turn: Turn) {
  return {
    id: turn.id,
    conversationId: turn.conversation_id,
    seq: turn.seq,
    userText: turn.user_text,
    status: turn.status,
    finalText: turn.final_text,
    citations: turn.citations,
    errorMessage: turn.error_message,
    tainted: turn.tainted,
    model: turn.model,
    usage: { steps: turn.steps, inputTokens: turn.input_tokens, outputTokens: turn.output_tokens, cacheReadTokens: turn.cache_read_tokens, activeMs: turn.active_ms },
    createdAt: turn.created_at.toISOString(),
    completedAt: turn.completed_at?.toISOString() ?? null,
    activity: await activityFor(turn.id),
    pendingAction: turn.status === 'waiting_confirmation' ? await pendingActionFor(turn.id) : null,
  }
}
