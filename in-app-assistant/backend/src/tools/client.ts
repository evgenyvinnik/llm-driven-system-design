/**
 * Client tools: executed by the browser, not the server. The orchestrator
 * sends a tool.request event down the stream, saves the turn and frees the
 * worker; the browser posts the result back to any API instance, which
 * resumes the turn.
 * @module tools/client
 */
import type { ToolSpec } from './types.js'

export const getSelection: ToolSpec = {
  name: 'get_selection',
  description:
    'Read what the user has selected in the open document right now, straight from their editor: the doc_id, the selected paragraph ids and text, and the live document version (which may include edits not saved yet). Use it when the user says "this", "the selected text" or "this paragraph".',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  apps: ['docs'],
  execution: 'client',
  effect: 'read',
  reversible: true,
  timeoutMs: 30000,
  statusLabel: () => 'Reading your selection…',
}

export const openItem: ToolSpec = {
  name: 'open_item',
  description:
    "Open an email, document, event or draft in the app so the user can see it. Only changes what's on the user's screen. Use ids from earlier results.",
  inputSchema: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: ['message', 'doc', 'event', 'draft'] },
      id: { type: 'string', pattern: '^(m|doc|ev|dr)_[a-z0-9]+$' },
    },
    required: ['kind', 'id'],
    additionalProperties: false,
  },
  apps: ['mail', 'docs', 'calendar'],
  execution: 'client',
  effect: 'read',
  reversible: true,
  timeoutMs: 30000,
  statusLabel: () => 'Opening it for you…',
}
