/**
 * The parsed, normalized form of a workflow. This is what gets copied onto the
 * job rows at run creation, so a re-run executes exactly what the first attempt did.
 * @module workflow/types
 */

export interface ParsedStep {
  name: string
  run: string
  /** Default true. `idempotent: false` means a second execution may do harm: never retried automatically. */
  idempotent: boolean
  timeoutSeconds: number
  env: Record<string, string>
}

export interface ParsedUpload {
  name: string
  path: string
  retentionDays: number
}

export interface ParsedJob {
  key: string
  name: string
  needs: string[]
  runsOn: string[]
  environment: string | null
  secrets: string[]
  env: Record<string, string>
  steps: ParsedStep[]
  uploads: ParsedUpload[]
  matrix: Record<string, string> | null
}

export interface TriggerFilter {
  branches: string[] | null
}

export interface ParsedWorkflow {
  name: string
  on: Partial<Record<'push' | 'pull_request', TriggerFilter>>
  jobs: ParsedJob[]
}

export interface WorkflowError {
  code: 'YAML_SYNTAX' | 'UNKNOWN_FIELD' | 'INVALID_FIELD' | 'UNKNOWN_NEEDS' | 'DEPENDENCY_CYCLE' | 'TOO_LARGE' | 'DUPLICATE_JOB'
  path: string
  message: string
}

export type ParseResult = { ok: true; workflow: ParsedWorkflow } | { ok: false; errors: WorkflowError[] }
