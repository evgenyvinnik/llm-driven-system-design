/**
 * Agent tools: an allowlist of two read-only tools, enforced outside the model.
 *
 * - Reads go through the host API at the pinned SHA. The model cannot pass a ref.
 * - Paths are normalized, then traversal, absolute paths and secrets are refused.
 * - There is no approve, merge or comment tool. A request for one is denied like
 *   any unknown name, and the denial is audited and escalates the review.
 * - Results are untrusted content too, and go back to the model wrapped as such.
 * @module worker/tools
 */
import { z } from 'zod'
import { matchesAny, normalizePath } from '../shared/gate/paths.js'
import type { ToolCall, ToolDefinition } from '../shared/model-types.js'

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'read_file',
    description: 'Read a text file from this repository at the commit under review.',
    input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
  },
  {
    name: 'list_changed_files',
    description: 'List the files changed by this pull request.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
]

export const SECRET_PATH_DENYLIST = ['.env', '.env.*', '**/.env', '**/.env.*', '**/*.pem', '**/*.key', '**/id_rsa*', '**/.npmrc', '**/.netrc', '**/credentials*', 'secrets/**', '**/secrets/**', '.git/**', '**/.git/**']

const MAX_FILE_BYTES = 32_000

const readFileInput = z.object({ path: z.string().min(1).max(1024) }).strict()
const listInput = z.object({}).strict()

export type DenialReason = 'unknown_tool' | 'invalid_arguments' | 'path_escapes_repo' | 'secret_path' | 'budget_exceeded'

export interface ToolRecord {
  id: string
  name: string
  input: unknown
  allowed: boolean
  denialReason?: DenialReason
  /** What the model was told. */
  result: string
  resultBytes: number
}

export interface ToolContext {
  readFile(path: string): Promise<string | null>
  changedFiles(): { path: string; previousPath: string | null; status: string }[]
  callsSoFar: number
  maxCalls: number
}

function denied(call: ToolCall, reason: DenialReason, message: string): ToolRecord {
  return { id: call.id, name: call.name, input: call.input, allowed: false, denialReason: reason, result: `Denied: ${message}`, resultBytes: 0 }
}

/** Never throws for anything the model sends. Whatever it asks for becomes a record. */
export async function executeTool(call: ToolCall, ctx: ToolContext): Promise<ToolRecord> {
  if (ctx.callsSoFar >= ctx.maxCalls) return denied(call, 'budget_exceeded', `at most ${ctx.maxCalls} tool calls per review`)

  if (call.name === 'list_changed_files') {
    if (!listInput.safeParse(call.input ?? {}).success) return denied(call, 'invalid_arguments', 'list_changed_files takes no arguments')
    const result = JSON.stringify(ctx.changedFiles())
    return { id: call.id, name: call.name, input: call.input, allowed: true, result, resultBytes: result.length }
  }

  if (call.name === 'read_file') {
    const parsed = readFileInput.safeParse(call.input)
    // A `ref` or any other extra field lands here: the commit is not the model's to choose.
    if (!parsed.success) return denied(call, 'invalid_arguments', 'read_file takes exactly one argument, path')
    const n = normalizePath(parsed.data.path)
    if (n.escapesRoot || n.absolute || n.hadControlChars) return denied(call, 'path_escapes_repo', 'paths must stay inside this repository')
    if (matchesAny(n.path, SECRET_PATH_DENYLIST)) return denied(call, 'secret_path', 'that path is not readable')
    const content = await ctx.readFile(parsed.data.path)
    const result = content === null ? 'Not found at this commit' : content.slice(0, MAX_FILE_BYTES)
    return { id: call.id, name: call.name, input: call.input, allowed: true, result, resultBytes: result.length }
  }

  return denied(call, 'unknown_tool', `there is no tool named ${String(call.name).slice(0, 60)}`)
}
