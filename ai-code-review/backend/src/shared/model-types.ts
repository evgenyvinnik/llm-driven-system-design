/**
 * The model interface, in Messages API format. The live worker reads it over SSE
 * (worker/model-client.ts); the seed and the offline evaluation use the same
 * reviewer in-process (model/in-process.ts). Both paths return these types.
 * @module shared/model-types
 */

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }

export interface ModelMessage {
  role: 'user' | 'assistant'
  content: string | ContentBlock[]
}

export interface ToolDefinition {
  name: string
  description: string
  input_schema: Record<string, unknown>
}

export interface ModelRequest {
  model: string
  system: string
  messages: ModelMessage[]
  tools: ToolDefinition[]
  max_tokens: number
}

export interface ToolCall {
  id: string
  name: string
  input: unknown
}

export interface ModelResult {
  /** The version the provider says served this call, recorded verbatim in the audit log. */
  model: string
  text: string
  toolCalls: ToolCall[]
  stopReason: string
  inputTokens: number
  outputTokens: number
  ttftMs: number
  generationMs: number
}

export type ModelErrorCode = 'overloaded' | 'rate_limited' | 'timeout' | 'disconnect' | 'aborted' | 'http_error' | 'protocol'

export class ModelCallError extends Error {
  constructor(
    public code: ModelErrorCode,
    message: string,
    public retryAfterMs?: number,
  ) {
    super(message)
  }
}

export type ModelCaller = (request: ModelRequest, opts: { signal?: AbortSignal; runId?: string }) => Promise<ModelResult>

export const MODEL_MAX_TOKENS = 2048
