/**
 * Reads a Messages API request the way the mock planner needs it: the current
 * turn's request and context, earlier turns as plain text, and the tool calls
 * and results so far in this turn. The request is the model's entire world;
 * there is no other state.
 * @module model/conversation
 */

export interface ToolCall {
  id: string
  name: string
  input: Record<string, unknown>
}

export interface ToolResult {
  isError: boolean
  text: string
  json: Record<string, unknown> | null
}

export interface OpenDocument {
  doc_id: string
  title: string
  version?: number
  selection?: string[]
  outline?: { id: string; kind: string; text: string }[]
}

export interface TurnContext {
  today: string
  timezone: string
  app: string
  user: string
  openDocument?: OpenDocument
  openMessage?: string
}

export interface PrefetchedPassage {
  id: string
  kind: string
  title: string
  from?: string
  thread?: string
  text: string
}

export interface ConversationView {
  toolNames: Set<string>
  toolChoiceNone: boolean
  structured: boolean
  system: string
  context: TurnContext
  request: string
  prefetched: PrefetchedPassage[]
  history: string[]
  steps: ToolCall[][]
  results: Map<string, ToolResult>
  wrapUp: boolean
  /** Text already emitted before a max_tokens cutoff, when the orchestrator asked to continue. */
  continuation: string | null
  lastUserText: string
}

type Block = { type: string; [key: string]: unknown }
type Message = { role: string; content: string | Block[] }

export interface RawRequest {
  model: string
  system?: string | { type: string; text: string }[]
  messages: Message[]
  tools?: { name: string }[]
  tool_choice?: { type: string }
  output_config?: { format?: { type: string } }
  max_tokens: number
}

const blocksOf = (message: Message): Block[] =>
  typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content

const textOf = (message: Message): string =>
  blocksOf(message)
    .filter((b) => b.type === 'text')
    .map((b) => String(b.text))
    .join('\n')

/** The last occurrence wins: the current request comes after any quoted history. */
function tag(text: string, name: string): string | null {
  const matches = [...text.matchAll(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'g'))]
  return matches.length ? matches[matches.length - 1][1].trim() : null
}

function parseContext(raw: string | null): TurnContext {
  const context: TurnContext = { today: new Date().toISOString().slice(0, 10), timezone: 'UTC', app: 'mail', user: '' }
  if (!raw) return context
  for (const line of raw.split('\n')) {
    const colon = line.indexOf(':')
    if (colon === -1) continue
    const key = line.slice(0, colon).trim()
    const value = line.slice(colon + 1).trim()
    if (key === 'today') context.today = value.slice(0, 10)
    else if (key === 'time_zone') context.timezone = value
    else if (key === 'app') context.app = value
    else if (key === 'user') context.user = value
    else if (key === 'open_message') context.openMessage = value
    else if (key === 'open_document') {
      try {
        context.openDocument = JSON.parse(value) as OpenDocument
      } catch {
        // A malformed context line is ignored, as a model would skim past it.
      }
    }
  }
  return context
}

function parsePassages(raw: string | null): PrefetchedPassage[] {
  if (!raw) return []
  const passages: PrefetchedPassage[] = []
  for (const match of raw.matchAll(/<passage ([^>]*)>([\s\S]*?)<\/passage>/g)) {
    const attrs = Object.fromEntries([...match[1].matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1], m[2]]))
    passages.push({ id: attrs.id, kind: attrs.kind, title: attrs.title ?? '', from: attrs.from, thread: attrs.thread, text: match[2].trim() })
  }
  return passages
}

function parseJson(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(text)
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}

export function readConversation(req: RawRequest): ConversationView {
  const messages = req.messages
  let turnStart = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user' && textOf(messages[i]).includes('<user_request>')) {
      turnStart = i
      break
    }
  }
  const history: string[] = []
  for (const message of messages.slice(0, Math.max(0, turnStart))) {
    const text = textOf(message)
    const request = tag(text, 'user_request')
    if (message.role === 'user') {
      const summary = tag(text, 'earlier_conversation')
      if (summary) history.push(summary)
      if (request) history.push(request)
    } else if (text.trim()) {
      history.push(text)
    }
  }
  const turnText = turnStart >= 0 ? textOf(messages[turnStart]) : textOf(messages[messages.length - 1])
  const steps: ToolCall[][] = []
  const results = new Map<string, ToolResult>()
  let continuation: string | null = null
  let pendingText = ''
  for (const message of messages.slice(turnStart + 1)) {
    const blocks = blocksOf(message)
    if (message.role === 'assistant') {
      const calls = blocks.filter((b) => b.type === 'tool_use').map((b) => ({ id: String(b.id), name: String(b.name), input: (b.input ?? {}) as Record<string, unknown> }))
      if (calls.length) steps.push(calls)
      pendingText += blocks.filter((b) => b.type === 'text').map((b) => String(b.text)).join('')
    } else {
      for (const block of blocks) {
        if (block.type === 'tool_result') {
          const content = block.content
          const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map((c: Block) => String(c.text ?? '')).join('') : ''
          results.set(String(block.tool_use_id), { isError: block.is_error === true, text, json: parseJson(text) })
          pendingText = ''
        }
      }
      const text = textOf(message)
      if (/continue where you left off/i.test(text)) continuation = pendingText
      else if (blocks.some((b) => b.type === 'tool_result')) continuation = null
    }
  }
  const last = messages[messages.length - 1]
  const lastUserText = last?.role === 'user' ? textOf(last) : ''
  const system = typeof req.system === 'string' ? req.system : (req.system ?? []).map((b) => b.text).join('\n')
  return {
    toolNames: new Set((req.tools ?? []).map((t) => t.name)),
    toolChoiceNone: req.tool_choice?.type === 'none',
    structured: req.output_config?.format?.type === 'json_schema',
    system,
    context: parseContext(tag(turnText, 'turn_context')),
    request: tag(turnText, 'user_request') ?? turnText,
    prefetched: parsePassages(tag(turnText, 'prefetched_results')),
    history,
    steps,
    results,
    wrapUp: /<wrap_up>/.test(lastUserText),
    continuation: last?.role === 'user' && /continue where you left off/i.test(lastUserText) ? continuation : null,
    lastUserText,
  }
}

/** Every call of a tool in this turn, paired with its result (if any yet). */
export function callsOf(view: ConversationView, name: string): { call: ToolCall; result?: ToolResult }[] {
  return view.steps.flat().filter((c) => c.name === name).map((call) => ({ call, result: view.results.get(call.id) }))
}

export function lastOk(view: ConversationView, name: string): Record<string, unknown> | null {
  const ok = callsOf(view, name).filter((c) => c.result && !c.result.isError && c.result.json)
  return ok.length ? ok[ok.length - 1].result!.json : null
}

export function lastError(view: ConversationView, name: string): string | null {
  const calls = callsOf(view, name)
  const last = calls[calls.length - 1]
  return last?.result?.isError ? last.result.text : null
}

export function called(view: ConversationView, name: string): boolean {
  return callsOf(view, name).some((c) => c.result && !c.result.isError)
}
