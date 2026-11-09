/**
 * The system composes everything the bot says on a pull request. Model text
 * only appears sanitized and labeled, inside a comment; an approval body never
 * contains model text at all, so it cannot be used as a trusted megaphone.
 * @module shared/comment
 */
import type { DecisionResult } from './gate/decide.js'
import type { GateResult } from './gate/types.js'
import { sanitizeForComment, type ModelOutput } from './model-output.js'

export function approvalBody(headSha: string, gate: GateResult): string {
  return `Automatically approved for commit ${headSha}: category ${gate.category}, policy ${gate.policyVersion}, all ${gate.rules.length} rules passed. This approval applies to this commit only.`
}

export function humanApprovalBody(headSha: string, approver: string, note: string | null): string {
  return `Approved by ${approver} in the review console for commit ${headSha}.${note ? ` Note: ${sanitizeForComment(note, 300)}` : ''}`
}

export function modelSection(output: ModelOutput | null): string {
  if (!output) return ''
  const lines = [`Model opinion (untrusted, advisory only): ${sanitizeForComment(output.summary)}`]
  for (const f of output.findings.slice(0, 10)) {
    const where = f.path ? ` (${sanitizeForComment(f.path, 120)})` : ''
    lines.push(`- ${f.severity}: ${sanitizeForComment(f.title, 160)}${where}. ${sanitizeForComment(f.detail, 300)}`)
  }
  return lines.join('\n')
}

export function shadowComment(headSha: string, result: DecisionResult, output: ModelOutput | null): string {
  const would = result.would === 'approve' ? 'would have approved this commit' : 'would have sent this commit to a person'
  return [`AI review, observation only. Nothing was approved. Commit ${headSha}: this system ${would}. Reason: ${sanitizeForComment(result.reason, 400)}`, modelSection(output)].filter(Boolean).join('\n\n')
}

export function escalationComment(headSha: string, result: DecisionResult, output: ModelOutput | null): string {
  return [`AI review sent commit ${headSha} to a person. Reason: ${sanitizeForComment(result.reason, 400)}`, modelSection(output)].filter(Boolean).join('\n\n')
}
