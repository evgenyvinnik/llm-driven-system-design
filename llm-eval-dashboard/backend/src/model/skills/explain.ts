/**
 * HTTP status explanations, graded by the model judge. The mock has a small
 * knowledge base; confusable pairs (401/403, 502/504, ...) are where it
 * slips, less so when the prompt asks for the official name. A "one sentence"
 * prompt gives a concise answer; otherwise the answer is padded with generic
 * advice, which a lenient rubric accepts and a strict one penalizes.
 * @module model/skills/explain
 */
import type { SkillContext, SkillOutput } from './types.js'

export const HTTP_STATUS: Record<number, { name: string; meaning: string; context: string }> = {
  200: { name: 'OK', meaning: 'the request succeeded and the response carries the result', context: 'on almost every successful page load' },
  201: { name: 'Created', meaning: 'the request succeeded and a new resource was created', context: 'after a successful POST that creates something' },
  204: { name: 'No Content', meaning: 'the request succeeded and there is no body to return', context: 'after a delete or a save with nothing to send back' },
  301: { name: 'Moved Permanently', meaning: 'the resource has a new permanent URL', context: 'when a site restructures its links' },
  302: { name: 'Found', meaning: 'the resource is temporarily at a different URL', context: 'during login redirects' },
  304: { name: 'Not Modified', meaning: 'the cached copy is still valid', context: 'when a conditional GET hits the cache' },
  400: { name: 'Bad Request', meaning: 'the server cannot process a malformed request', context: 'when a body fails to parse' },
  401: { name: 'Unauthorized', meaning: 'authentication is required or has failed', context: 'when a token is missing or expired' },
  403: { name: 'Forbidden', meaning: 'the server understood the request but refuses to authorize it', context: 'when a signed-in user lacks permission' },
  404: { name: 'Not Found', meaning: 'the server cannot find the requested resource', context: 'after following a broken link' },
  409: { name: 'Conflict', meaning: 'the request conflicts with the current state of the resource', context: 'when two edits race' },
  410: { name: 'Gone', meaning: 'the resource was removed permanently', context: 'for deleted content that will not return' },
  422: { name: 'Unprocessable Content', meaning: 'the request is well formed but has semantic errors', context: 'when validation fails' },
  429: { name: 'Too Many Requests', meaning: 'the client sent too many requests in a given time', context: 'when a rate limit is hit' },
  500: { name: 'Internal Server Error', meaning: 'the server hit an unexpected condition', context: 'when an unhandled exception escapes' },
  502: { name: 'Bad Gateway', meaning: 'an upstream server returned an invalid response', context: 'when a proxy talks to a crashed backend' },
  503: { name: 'Service Unavailable', meaning: 'the server is temporarily overloaded or down for maintenance', context: 'during deploys and overloads' },
  504: { name: 'Gateway Timeout', meaning: 'an upstream server did not respond in time', context: 'when a backend hangs behind a proxy' },
}

const CONFUSABLE: Record<number, number> = { 401: 403, 403: 401, 301: 302, 302: 301, 502: 504, 504: 502, 400: 422, 422: 400, 404: 410, 410: 404, 500: 503, 503: 500 }

/** The reference answer format the dataset uses. */
export function statusReference(code: number): string {
  const s = HTTP_STATUS[code]
  return s ? `${code} ${s.name}: ${s.meaning}.` : `${code}`
}

export function explainSkill(ctx: SkillContext): SkillOutput {
  const m = /\b([1-5]\d\d)\b/.exec(ctx.prompt)
  const code = m ? Number(m[1]) : 200
  const known = HTTP_STATUS[code]
  if (!known) return { text: `HTTP ${code} is not a status code I know well; check the RFC 9110 registry.`, detail: { skill: 'explain', code } }
  const officialName = ctx.text.includes('official name')
  const partner = CONFUSABLE[code]
  const p = ctx.spec.baseError + (officialName ? 0 : 0.08) + (partner ? 0.18 : 0)
  const wrong = partner !== undefined && ctx.draw('explain') < p
  const used = wrong ? HTTP_STATUS[partner] : known
  const concise = /one sentence|single sentence/.test(ctx.text)
  const text = concise
    ? `${code} ${used.name}: ${used.meaning}.`
    : `HTTP ${code} ${used.name} is a standard response status code. It means ${used.meaning}. You usually see it ${used.context}. When debugging, check the request headers, the server logs and any proxy in between before retrying.`
  return { text, detail: { skill: 'explain', code, wrong, p } }
}
