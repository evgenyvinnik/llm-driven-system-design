/** API shapes, mirroring the backend serializers. */

export type RunStatus = 'queued' | 'running' | 'completed' | 'cancelled' | 'failed'
export const TERMINAL: readonly RunStatus[] = ['completed', 'cancelled', 'failed']
export const isTerminal = (status: RunStatus) => TERMINAL.includes(status)

export interface User {
  id: string
  username: string
  displayName: string
  role: 'user' | 'admin'
  workspaceId: string
  workspaceName: string
}

export interface ModelInfo {
  id: string
  label: string
  description: string
  maxOutputTokens: number
}

export interface ModelConfig {
  model: string
  temperature: number
  maxTokens: number
  topP: number
}

export interface PersonRef {
  id: string
  displayName: string
}

export interface Prompt {
  id: string
  workspaceId: string
  title: string
  description: string
  headVersion: number
  createdBy: PersonRef
  updatedBy: PersonRef
  createdAt: string
  updatedAt: string
}

export interface PromptListItem extends Prompt {
  runCount: number
  lastRun: { id: string; status: RunStatus; model: string; createdAt: string } | null
}

export interface VersionDetail {
  version: number
  message: string
  system: string
  template: string
  variables: string[]
  snapshotId: string
  createdBy: PersonRef
  createdAt: string
}

export interface VersionSummary {
  version: number
  message: string
  createdBy: string
  createdAt: string
}

export interface PromptDetail {
  prompt: Prompt
  head: VersionDetail | null
  versions: VersionSummary[]
}

export interface RunUsage {
  inputTokens: number | null
  outputTokens: number | null
  queueMs: number | null
  ttftMs: number | null
  durationMs: number | null
}

export interface Run {
  id: string
  promptId: string
  snapshotId: string
  version: number | null
  savedVersion: number | null
  comparisonId: string | null
  model: string
  config: ModelConfig
  variables: Record<string, string>
  status: RunStatus
  output?: string
  outputPreview?: string
  system?: string
  input?: string
  outputTruncated: boolean
  finishReason: string | null
  errorCode: string | null
  errorMessage: string | null
  usage: RunUsage
  attempt: number
  cancelRequested: boolean
  createdBy: PersonRef
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
  promptTitle?: string
}

export interface Preset {
  id: string
  name: string
  config: ModelConfig
  revision: number
  updatedBy: string
  updatedAt: string
}

export interface Share {
  token: string
  kind: 'run' | 'version'
  version: number | null
  runId: string | null
  createdBy?: string
  createdAt?: string
  path: string
}

export interface SharedView {
  share: { token: string; kind: 'run' | 'version'; sharedBy: string; createdAt: string }
  prompt: { title: string }
  version: number | null
  snapshot: { system: string; template: string; variables: string[] }
  run: {
    model: string
    config: ModelConfig
    variables: Record<string, string>
    status: RunStatus
    output: string
    outputTruncated: boolean
    finishReason: string | null
    errorMessage: string | null
    usage: RunUsage
    createdAt: string
  } | null
}

export interface AdminOverview {
  statusCounts: Partial<Record<RunStatus, number>>
  active: { queued: number; running: number; oldestQueuedSeconds: number | null }
  perModel: {
    model: string
    runs: number
    failed: number
    ttftP50Ms: number | null
    ttftP95Ms: number | null
    queueP50Ms: number | null
    durationP95Ms: number | null
    inputTokens: number
    outputTokens: number
  }[]
  hourly: { hour: string; runs: number; failed: number }[]
  topUsers: { displayName: string; runs: number; tokens: number }[]
  recentFailures: {
    id: string
    model: string
    errorCode: string | null
    errorMessage: string | null
    promptTitle: string
    createdAt: string
  }[]
  executors: { id: string; inFlight: number; concurrency: number; startedAt: string; lastSeen: string }[]
}

export interface ModelSettings {
  failureRateOverride: number | null
  latencyMultiplier: number
  maxConcurrent: number
}
