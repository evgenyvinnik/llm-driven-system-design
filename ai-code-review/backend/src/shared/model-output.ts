/**
 * Model output is untrusted data. It is parsed against a strict schema: one
 * JSON object, nothing around it, no unknown fields, bounded sizes. Anything
 * else is `malformed` and escalates. There is no fallback search for a word,
 * no repair, and no retry, because a parser that tries harder is a parser an
 * attacker can aim at.
 * @module shared/model-output
 */
import { z } from 'zod'

export const MAX_RAW_OUTPUT_CHARS = 32_000

const findingSchema = z
  .object({
    severity: z.enum(['info', 'warning', 'critical']),
    path: z.string().max(400).optional(),
    line: z.number().int().positive().optional(),
    title: z.string().min(1).max(160),
    detail: z.string().max(1000),
  })
  .strict()

export const modelOutputSchema = z
  .object({
    verdict: z.enum(['approve', 'needs_human', 'request_changes']),
    risk: z.enum(['low', 'medium', 'high']),
    confidence: z.number().min(0).max(1),
    summary: z.string().min(1).max(2000),
    findings: z.array(findingSchema).max(30),
  })
  .strict()

export type ModelOutput = z.infer<typeof modelOutputSchema>
export type Finding = z.infer<typeof findingSchema>

export type ParseResult = { ok: true; output: ModelOutput } | { ok: false; error: string }

/** Parsers disagree about duplicate keys (first wins or last wins), so a duplicate is refused. */
function hasDuplicateTopLevelKey(raw: string): boolean {
  for (const key of ['verdict', 'risk', 'confidence']) {
    const count = raw.match(new RegExp(`"${key}"\\s*:`, 'g'))?.length ?? 0
    if (count > 1) return true
  }
  return false
}

export function parseModelOutput(raw: string): ParseResult {
  if (raw.length > MAX_RAW_OUTPUT_CHARS) return { ok: false, error: `Output is ${raw.length} characters, over the ${MAX_RAW_OUTPUT_CHARS} limit` }
  const text = raw.trim()
  if (!text.startsWith('{') || !text.endsWith('}')) return { ok: false, error: 'Output is not a single JSON object' }
  if (hasDuplicateTopLevelKey(text)) return { ok: false, error: 'Output repeats a decision field' }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return { ok: false, error: 'Output is not valid JSON' }
  }
  const parsed = modelOutputSchema.safeParse(value)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    return { ok: false, error: `Schema violation at ${issue.path.join('.') || '(root)'}: ${issue.message}` }
  }
  return { ok: true, output: parsed.data }
}

/**
 * Model text can end up in a comment under the bot's trusted name, so it is
 * neutralized first: images and links (a URL can carry stolen data), mentions,
 * HTML. The result is plain text inside a comment the poster composes.
 */
export function sanitizeForComment(text: string, maxLength = 600): string {
  const cleaned = text
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '[image removed: $1]')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1 [link removed]')
    .replace(/\bhttps?:\/\/\S+/gi, '[link removed]')
    .replace(/\bdata:\S+/gi, '[data removed]')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/@(?=[A-Za-z0-9_-])/g, '@​')
    .replace(/`/g, "'")
  return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength)}…` : cleaned
}
