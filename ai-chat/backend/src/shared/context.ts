/**
 * Builds the model context for a generation from the conversation path.
 *
 * The server, not the client, decides what the model sees. Walking backwards
 * from the newest message, messages are kept while they fit the token budget;
 * the newest user message is always kept, trimmed if it alone is too large.
 * Assistant messages that ended with no output (failed before the first
 * token) carry nothing and are skipped. A partial answer the user saw (a
 * stopped or failed generation with some output) is kept: the user may refer to it.
 * @module shared/context
 */
import { estimateTokens } from './catalog.js'

export interface ContextMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface BuiltContext {
  messages: ContextMessage[]
  /** Messages on the path that did not fit the budget. */
  dropped: number
  inputTokens: number
}

export function buildContext(path: ContextMessage[], budgetTokens: number): BuiltContext {
  const usable = path.filter((m) => m.content.trim().length > 0)
  const kept: ContextMessage[] = []
  let used = 0
  for (let i = usable.length - 1; i >= 0; i--) {
    const message = usable[i]
    const cost = estimateTokens(message.content)
    if (kept.length === 0) {
      // The message being answered is always included.
      const content = cost > budgetTokens ? message.content.slice(-budgetTokens * 4) : message.content
      kept.push({ ...message, content })
      used += estimateTokens(content)
      continue
    }
    if (used + cost > budgetTokens) break
    kept.push(message)
    used += cost
  }
  kept.reverse()
  return { messages: kept, dropped: usable.length - kept.length, inputTokens: used }
}

/** Short title from the first user message, cut at a word boundary. */
export function titleFromMessage(content: string, max = 48): string {
  const flat = content.replace(/\s+/g, ' ').trim()
  if (flat.length === 0) return 'New chat'
  if (flat.length <= max) return flat
  const cut = flat.slice(0, max)
  const space = cut.lastIndexOf(' ')
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s.,;:!?-]+$/, '')}…`
}
