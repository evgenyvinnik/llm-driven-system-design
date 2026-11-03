/**
 * Tool registry. Only tools that fit the current app and the user's settings
 * reach the model: it can't misuse a tool it never sees, which is simpler and
 * safer than blocking the call afterwards.
 *
 * The order is fixed and the definitions never vary per request, because the
 * tool list is part of the cached prompt prefix.
 * @module tools/registry
 */
import { createHash } from 'node:crypto'
import type Anthropic from '@anthropic-ai/sdk'
import { getSelection, openItem } from './client.js'
import { createEvent, searchEvents } from './calendar.js'
import { insertText, readDocument, replaceText, searchDocs } from './docs.js'
import { createDraft, getMessage, getThread, searchMail, sendDraft } from './mail.js'
import type { App, ToolSpec } from './types.js'

export const ALL_TOOLS: ToolSpec[] = [
  searchMail,
  getMessage,
  getThread,
  createDraft,
  sendDraft,
  searchDocs,
  readDocument,
  insertText,
  replaceText,
  getSelection,
  searchEvents,
  createEvent,
  openItem,
]

const byName = new Map(ALL_TOOLS.map((t) => [t.name, t]))

export function getTool(name: string): ToolSpec | undefined {
  return byName.get(name)
}

export interface ToolSettings {
  allow_send: boolean
  allow_doc_edits: boolean
}

export function toolsFor(app: App, settings: ToolSettings): ToolSpec[] {
  return ALL_TOOLS.filter((t) => t.apps.includes(app) && (!t.setting || settings[t.setting]))
}

export function toApiTools(tools: ToolSpec[]): Anthropic.Beta.Messages.BetaToolUnion[] {
  return tools.map((t, i) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema as Anthropic.Beta.Messages.BetaTool.InputSchema,
    // One cache breakpoint at the end of the tool list caches every definition.
    ...(i === tools.length - 1 ? { cache_control: { type: 'ephemeral' as const } } : {}),
  }))
}

/** Changes whenever the visible tool set changes; the context assembler watches it. */
export function toolsetHash(tools: ToolSpec[]): string {
  return createHash('sha1').update(tools.map((t) => t.name).join(',')).digest('hex').slice(0, 12)
}
