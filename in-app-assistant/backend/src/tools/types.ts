/**
 * Tool contract. The model sees only `name`, `description` and `inputSchema`;
 * everything else is metadata the orchestrator and policy engine act on.
 * Safety lives here, in code, not in the description: a description saying
 * "only call this if the user asked" is a suggestion that text injected into
 * an email can talk the model out of.
 * @module tools/types
 */
import type { Queryable } from '../shared/db.js'

export type App = 'mail' | 'docs' | 'calendar'

/** read: changes nothing. write: changes the user's own data. send: reaches people or systems outside the app. */
export type Effect = 'read' | 'write' | 'send'

export interface Source {
  /** Citation ID the model writes in brackets: m_off1, doc_offsite#p_3, ev_sync, dr_k3f9q2. */
  id: string
  kind: 'mail' | 'doc' | 'event' | 'draft'
  title: string
  subtitle?: string
  /** Host-app route that opens the item. */
  href: string
}

export interface ToolContext {
  userId: string
  orgId: string
  email: string
  timezone: string
  turnId: string
  callId: string
  principals: string[]
  orgDomain: string
  /** Pool for reads; the idempotency transaction for writes. */
  db: Queryable
}

export interface ToolOutput {
  /** JSON shown to the model (after shrinking). Keep IDs; drop noise. */
  content: Record<string, unknown>
  /** Content came from outside the user's control: an external email or someone else's document. */
  untrusted?: boolean
  sources?: Source[]
  /** One line for the UI and audit log ("3 results", "Draft dr_x saved"). */
  summary: string
}

/** Facts about a pending call that the policy engine and the confirmation card need. */
export interface CallFacts {
  externalRecipients: string[]
  title: string
  preview: Record<string, unknown>
}

export interface ToolSpec<A = Record<string, unknown>> {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  apps: App[]
  execution: 'server' | 'client'
  effect: Effect | ((args: A) => Effect)
  reversible: boolean | ((args: A) => boolean)
  /** Hidden from the model when the user's settings turn the capability off. */
  setting?: 'allow_send' | 'allow_doc_edits'
  timeoutMs: number
  statusLabel: (args: A) => string
  inspect?: (args: A, ctx: ToolContext) => Promise<CallFacts>
  run?: (args: A, ctx: ToolContext) => Promise<ToolOutput>
}

/** Thrown by tools for errors the model can fix. The message is written as an instruction. */
export class ToolError extends Error {}

export function effectOf(spec: ToolSpec, args: Record<string, unknown>): Effect {
  return typeof spec.effect === 'function' ? spec.effect(args) : spec.effect
}

export function isReversible(spec: ToolSpec, args: Record<string, unknown>): boolean {
  return typeof spec.reversible === 'function' ? spec.reversible(args) : spec.reversible
}
