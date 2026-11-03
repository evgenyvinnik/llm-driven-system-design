/**
 * Row types and their JSON shapes. Kept in one place so REST responses, SSE
 * snapshots and device events always describe an object the same way.
 */
import { isTerminal, type GenerationStatus, type GenerationUsage } from '../../shared/generation-events.js'

export interface ConversationRow {
  id: string
  user_id: string
  title: string
  model: string
  current_leaf_id: string | null
  created_at: Date
  updated_at: Date
  /** Microsecond-precision text form of updated_at, used for keyset cursors. */
  updated_cursor?: string
  active_generation_id?: string | null
}

export interface MessageRow {
  id: string
  conversation_id: string
  parent_id: string | null
  role: 'user' | 'assistant'
  content: string
  depth: number
  created_at: Date
}

export interface GenerationRow {
  id: string
  conversation_id: string
  user_id: string
  user_message_id: string
  assistant_message_id: string
  kind: 'message' | 'edit' | 'regenerate'
  model: string
  status: GenerationStatus
  request_hash: string
  attempt: number
  output: string
  checkpoint_event_id: string | null
  output_truncated: boolean
  finish_reason: string | null
  error_code: string | null
  error_message: string | null
  input_tokens: number | null
  output_tokens: number | null
  context_messages: number | null
  context_dropped: number | null
  created_at: Date
  started_at: Date | null
  first_token_at: Date | null
  finished_at: Date | null
  cancel_requested_at: Date | null
}

export const CONVERSATION_SELECT = `SELECT c.*,
    to_char(c.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_cursor,
    (SELECT g.id FROM generations g
      WHERE g.conversation_id = c.id AND g.status IN ('accepted', 'running') LIMIT 1) AS active_generation_id
  FROM conversations c`

export function serializeConversation(row: ConversationRow) {
  return {
    id: row.id,
    title: row.title,
    model: row.model,
    currentLeafId: row.current_leaf_id,
    activeGenerationId: row.active_generation_id ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  }
}

const ms = (from: Date | null, to: Date | null) => (from && to ? to.getTime() - from.getTime() : null)

export function generationUsage(row: GenerationRow): GenerationUsage {
  return {
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    queueMs: ms(row.created_at, row.started_at),
    ttftMs: ms(row.started_at, row.first_token_at),
    durationMs: ms(row.started_at, row.finished_at),
  }
}

export function serializeGeneration(row: GenerationRow) {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    userMessageId: row.user_message_id,
    assistantMessageId: row.assistant_message_id,
    kind: row.kind,
    model: row.model,
    status: row.status,
    /** Output as of checkpointEventId while running; the final output once ended. */
    output: row.output,
    checkpointEventId: row.checkpoint_event_id,
    outputTruncated: row.output_truncated,
    finishReason: row.finish_reason,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    usage: generationUsage(row),
    contextMessages: row.context_messages,
    contextDropped: row.context_dropped,
    cancelRequested: row.cancel_requested_at !== null,
    createdAt: row.created_at.toISOString(),
    startedAt: row.started_at?.toISOString() ?? null,
    finishedAt: row.finished_at?.toISOString() ?? null,
  }
}

export type SerializedGeneration = ReturnType<typeof serializeGeneration>

export function serializeMessage(row: MessageRow, siblingIds: string[], generation: GenerationRow | null) {
  const live = generation && !isTerminal(generation.status)
  return {
    id: row.id,
    conversationId: row.conversation_id,
    parentId: row.parent_id,
    role: row.role,
    // While an answer is being written its text lives on the generation (checkpointed).
    content: live ? generation.output : row.content,
    depth: row.depth,
    createdAt: row.created_at.toISOString(),
    siblingIds,
    generation: generation ? serializeGeneration(generation) : null,
  }
}

export type SerializedMessage = ReturnType<typeof serializeMessage>
