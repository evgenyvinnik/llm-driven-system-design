/** Display helpers. Text, never colour alone, carries the meaning. */

export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '—'
  const s = Math.round((now - new Date(iso).getTime()) / 1000)
  if (s < 60) return `${Math.max(0, s)}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

export const short = (sha: string | null | undefined) => (sha ? sha.slice(0, 7) : '—')

export function ms(v: number | null | undefined): string {
  if (v === null || v === undefined) return '—'
  return v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)} ms`
}

export const pct = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${Math.round(v * 1000) / 10}%`)

export const humanize = (id: string) => id.replace(/_/g, ' ')

export const OUTCOME_LABEL: Record<string, string> = {
  auto_approved: 'Auto-approved',
  escalated: 'Escalated',
  shadow: 'Shadow only',
  waiting_ci: 'Waiting for CI',
  human_approved: 'Human approved',
  human_rejected: 'Human rejected',
}

export const RULE_LABEL: Record<string, string> = {
  bound_to_current_head: 'Bound to the current head',
  ci_green_at_head: 'CI green at this SHA',
  required_reviewers_approved: 'Required reviewers approved at this SHA',
  no_protected_paths: 'No protected paths, including renames',
  within_size_limits: 'Within size limits',
  not_self_authored: 'Not self-authored',
  no_ci_config_changes: 'No CI configuration changes',
  no_policy_changes: 'No policy file changes',
  no_opaque_files: 'No binary files, symlinks or submodules',
  category_in_scope: 'Change category in scope',
}
