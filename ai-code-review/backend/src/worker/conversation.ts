/**
 * The model conversation: prompt, tool rounds, final text. Shared by the live
 * worker and the offline evaluation, so a replay exercises the same allowlist.
 * @module worker/conversation
 */
import type { ContentBlock, ModelCaller, ModelMessage, ModelRequest } from '../shared/model-types.js'
import { newNonce, wrapUntrusted } from './prompt.js'
import { executeTool, type ToolContext, type ToolRecord } from './tools.js'

export interface ConversationResult {
  text: string
  modelVersion: string
  tools: ToolRecord[]
  inputTokens: number
  outputTokens: number
  /** Time to first token of the first call. */
  ttftMs: number
  generationMs: number
  calls: number
}

export interface ConversationArgs {
  caller: ModelCaller
  request: ModelRequest
  tools: Omit<ToolContext, 'callsSoFar'>
  maxRounds: number
  signal?: AbortSignal
  runId?: string
  onTool?: (record: ToolRecord) => Promise<void>
}

export async function runConversation(a: ConversationArgs): Promise<ConversationResult> {
  const messages: ModelMessage[] = [...a.request.messages]
  const records: ToolRecord[] = []
  const nonce = newNonce()
  const result: ConversationResult = { text: '', modelVersion: a.request.model, tools: records, inputTokens: 0, outputTokens: 0, ttftMs: 0, generationMs: 0, calls: 0 }

  for (let round = 0; ; round++) {
    const res = await a.caller({ ...a.request, messages }, { signal: a.signal, runId: a.runId })
    result.calls++
    result.modelVersion = res.model
    result.inputTokens += res.inputTokens
    result.outputTokens += res.outputTokens
    if (round === 0) result.ttftMs = res.ttftMs
    result.generationMs += res.generationMs
    if (res.toolCalls.length === 0 || round >= a.maxRounds) {
      result.text = res.text
      return result
    }
    const assistant: ContentBlock[] = res.toolCalls.map((c) => ({ type: 'tool_use', id: c.id, name: c.name, input: c.input }))
    const replies: ContentBlock[] = []
    for (const call of res.toolCalls) {
      const record = await executeTool(call, { ...a.tools, callsSoFar: records.length })
      records.push(record)
      if (a.onTool) await a.onTool(record)
      // Whatever a file says is more untrusted content.
      replies.push({ type: 'tool_result', tool_use_id: call.id, content: wrapUntrusted('tool-result', nonce, record.result), is_error: !record.allowed })
    }
    messages.push({ role: 'assistant', content: assistant })
    messages.push({ role: 'user', content: replies })
  }
}
