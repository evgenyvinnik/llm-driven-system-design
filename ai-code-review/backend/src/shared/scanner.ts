/**
 * Injection scanner: known phrasings in untrusted content.
 *
 * This is a signal and nothing more. It can only escalate a change that would
 * otherwise be approved, and it is easy to evade on purpose: the fixtures
 * include a base64 and a leetspeak attempt that it misses, which the
 * deliberately gullible model still obeys. The defense is the gate, not this
 * file. Removing it would change no security property, only the alert rate.
 * @module shared/scanner
 */

const PATTERNS: { name: string; re: RegExp }[] = [
  { name: 'ignore_instructions', re: /\bignore\s+(all\s+|any\s+)?(previous|prior|above|earlier)\s+(instructions|prompts?)\b/i },
  { name: 'addressed_to_reviewer', re: /\b(ai|automated|llm)\s+(code\s+)?review(er|ers|ing)?\b.{0,80}\b(approve|approved|audited)\b/i },
  { name: 'demands_approval', re: /\b(you\s+must|must|please|always)\s+approve\b/i },
  { name: 'approve_with_confidence', re: /\b(respond|reply|answer)\s+with\s+.{0,20}approve\b/i },
  { name: 'system_override', re: /\b(system\s+override|new\s+system\s+prompt|developer\s+mode)\b/i },
  { name: 'tool_directive', re: /\bcall\s+(the\s+)?(approve_pull_request|merge_pull_request)\b/i },
  { name: 'secret_read', re: /\bread\s+\S*\.env\b/i },
]

export interface ScanInput {
  source: 'title' | 'body' | 'diff' | 'comment' | 'tool_result'
  text: string
}

export interface ScanHit {
  source: ScanInput['source']
  pattern: string
  excerpt: string
}

export function scanForInjection(inputs: ScanInput[]): ScanHit[] {
  const hits: ScanHit[] = []
  for (const input of inputs) {
    for (const { name, re } of PATTERNS) {
      const m = re.exec(input.text)
      if (m) {
        const start = Math.max(0, m.index - 20)
        hits.push({ source: input.source, pattern: name, excerpt: input.text.slice(start, m.index + m[0].length + 20).replace(/\s+/g, ' ').slice(0, 160) })
      }
    }
  }
  return hits
}
