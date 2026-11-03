/**
 * Policy engine: allow, confirm or deny each tool call, in code. It weighs
 * what the tool does (read, write, or send outside the app), whether the
 * action can be undone, the user's settings, and taint: once the turn has
 * read content the user doesn't control (an external email, someone else's
 * document), anything that sends data outside the org needs confirmation,
 * or is blocked if the user's settings say so.
 *
 * Every decision is recorded with its rule and reason. A deny goes back to
 * the model as a tool result, so it can explain or try another way.
 * @module orchestrator/policy
 */
import { effectOf, isReversible, type CallFacts, type ToolSpec } from '../tools/types.js'

export interface PolicySettings {
  confirm_writes: boolean
  block_external_after_untrusted: boolean
}

export interface Decision {
  action: 'allow' | 'confirm' | 'deny'
  rule: string
  reason: string
}

export interface PolicyInput {
  tool: ToolSpec
  args: Record<string, unknown>
  facts: CallFacts | null
  tainted: boolean
  settings: PolicySettings
}

const allow = (rule: string, reason: string): Decision => ({ action: 'allow', rule, reason })
const confirm = (rule: string, reason: string): Decision => ({ action: 'confirm', rule, reason })
const deny = (rule: string, reason: string): Decision => ({ action: 'deny', rule, reason })

export function decide({ tool, args, facts, tainted, settings }: PolicyInput): Decision {
  const effect = effectOf(tool, args)
  if (effect === 'read') return allow('read', 'Only reads data the user can already see')

  const external = facts?.externalRecipients ?? []
  if (effect === 'send') {
    if (tainted && external.length && settings.block_external_after_untrusted) {
      return deny(
        'untrusted-external-send',
        `Blocked by policy: earlier in this conversation you read content the user doesn't control, and their settings block sending outside the organization after that (${external.join(', ')}). Tell the user; they can send it themselves from Drafts.`,
      )
    }
    if (tainted && external.length) {
      return confirm(
        'untrusted-external-send',
        `Sends to ${external.join(', ')} outside your organization, after the assistant read content you don't control (an external email or a shared document) in this conversation`,
      )
    }
    return confirm('send', external.length ? `Sends to ${external.join(', ')} outside your organization` : "Sends to other people and can't be undone")
  }

  if (!isReversible(tool, args)) return confirm('irreversible-write', "This change can't be undone from the assistant")
  if (settings.confirm_writes) return confirm('confirm-every-change', 'Your settings ask to confirm every change the assistant makes')
  return allow('reversible-write', 'A reversible change to your own data')
}
