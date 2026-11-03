export type App = 'mail' | 'docs' | 'calendar'

export interface User {
  id: string
  username: string
  displayName: string
  email: string
  orgId: string
  role: 'user' | 'admin'
  timezone: string
}

export interface MailMessage {
  id: string
  threadId: string
  from: { name: string; email: string }
  to: string[]
  cc: string[]
  subject: string
  snippet: string
  sentAt: string
  unread: boolean
  external: boolean
  folder: string
  body?: string
}

export interface Draft {
  id: string
  to: string[]
  cc: string[]
  subject: string
  body: string
  inReplyTo: string | null
  createdBy: 'user' | 'assistant'
  status: string
  updatedAt: string
}

export interface DocumentSummary {
  id: string
  title: string
  owner: string
  ownerId: string
  role: 'owner' | 'editor' | 'viewer'
  updatedAt: string
}

export interface Paragraph {
  id: string
  kind: 'title' | 'heading' | 'body' | 'bullet'
  text: string
  suggestion: 'insert' | 'replace' | null
  suggestedText: string | null
  suggestedBy: string | null
}

export interface DocumentDetail {
  id: string
  title: string
  owner: string
  role: 'owner' | 'editor' | 'viewer'
  version: number
  paragraphs: Paragraph[]
  shares: { principal: string; role: 'viewer' | 'editor' }[]
}

export interface CalendarEvent {
  id: string
  title: string
  start: string
  end: string
  location: string | null
  attendees: string[]
  createdBy: 'user' | 'assistant'
}

export interface AssistantSettings {
  confirmWrites: boolean
  blockExternalAfterUntrusted: boolean
  allowSend: boolean
  allowDocEdits: boolean
  prefetch: boolean
  maxSteps: number
}

export interface Source {
  id: string
  kind: 'mail' | 'doc' | 'event' | 'draft'
  title: string
  subtitle?: string
  href: string
}

export interface Citation {
  id: string
  verified: boolean
  source?: Source
}

export type TurnStatus = 'running' | 'waiting_client' | 'waiting_confirmation' | 'completed' | 'failed' | 'cancelled'

export interface PendingAction {
  actionId: string
  callId: string
  tool: string
  title: string
  preview: Record<string, unknown>
  reason: string
  tainted: boolean
  expiresAt: string
}

export interface ActivityItem {
  kind: 'tool' | 'notice' | 'action'
  name: string
  summary: string
  ok: boolean
}

export interface TurnUsage {
  steps: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  activeMs?: number
}

export interface TurnDto {
  id: string
  conversationId: string
  seq: number
  userText: string
  status: TurnStatus
  finalText: string | null
  citations: Citation[]
  errorMessage: string | null
  tainted: boolean
  model: string | null
  usage: TurnUsage
  createdAt: string
  completedAt: string | null
  activity: ActivityItem[]
  pendingAction: PendingAction | null
}

export type TimelineItem =
  | { kind: 'text'; step: number; text: string }
  | { kind: 'tool'; callId: string; name: string; label: string; status: 'running' | 'waiting' | 'done' | 'failed'; summary?: string; error?: string }
  | { kind: 'notice'; noticeKind: string; message: string }
  | { kind: 'action'; action: PendingAction; status: 'pending' | 'approved' | 'declined' | 'expired' | 'submitting' }

export interface TurnState {
  id: string
  conversationId: string
  userText: string
  status: TurnStatus
  items: TimelineItem[]
  finalText: string | null
  citations: Citation[]
  usage: TurnUsage | null
  errorMessage: string | null
  tainted: boolean
  lastEventId?: string
  wrappedUp?: string | null
}

export interface TurnStep {
  id: number
  step: number
  kind: 'model_call' | 'tool_call' | 'policy' | 'notice' | 'wrap_up' | 'prefetch' | 'compaction'
  name: string | null
  detail: Record<string, unknown>
  latencyMs: number | null
  inputTokens: number | null
  outputTokens: number | null
  cacheReadTokens: number | null
  createdAt: string
}

export interface AdminOverview {
  turnsByStatus: Record<string, number>
  turnsByApp: Record<string, number>
  activeMs: { p50: number | null; p95: number | null }
  avgSteps: number | null
  tokens: { input: number; cacheRead: number; output: number; cacheHitRate: number | null }
  tools: { name: string; calls: number; errors: number; p50Ms: number | null }[]
  policy: { action: string; rule: string; count: number }[]
  confirmations: Record<string, number>
  feedback: Record<string, number>
  model: { provider: string; primary: string; fallback: string }
  instance: { id: string; runningTurns: number }
}

export interface AdminTurn {
  id: string
  status: TurnStatus
  userText: string
  app: App
  user: string
  steps: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  activeMs: number
  tainted: boolean
  model: string | null
  errorCode: string | null
  createdAt: string
}

export interface AdminTurnDetail {
  turn: {
    id: string
    status: TurnStatus
    userText: string
    finalText: string | null
    tainted: boolean
    model: string | null
    steps: number
    activeMs: number
    errorMessage: string | null
    citations: Citation[]
    clientContext: Record<string, unknown>
    messages: unknown[]
    createdAt: string
  }
  steps: Omit<TurnStep, 'id'>[]
  actions: { id: string; tool: string; args: Record<string, unknown>; reason: string; tainted: boolean; status: string; createdAt: string; decidedAt: string | null }[]
}

export interface IndexStatus {
  pending: { lane: string; count: number; oldestSeconds: number | null }[]
  chunks: { sourceType: string; count: number }[]
  lastIndexedAt: string | null
  failed: number
}

export interface MockModelSettings {
  ttftMs: number
  tokensPerSecond: number
  maxConcurrent: number
  followInjectedInstructions: boolean
  chaos: Record<string, number>
}

export interface EvalRun {
  id: number
  model: string
  createdAt: string
  summary: { tasks: number; passed: number; successRate: number; firstToolCorrectRate: number; validArgsRate: number; avgToolCalls: number; avgTokens: number; avgMs: number }
  results: { task: string; passed: boolean; failures: string[]; tools: string[]; toolCalls: number; steps: number; inputTokens: number; outputTokens: number; ms: number }[]
}

export interface OpenDocumentContext {
  doc_id: string
  title: string
  version: number
  selection: string[]
  outline: { id: string; kind: string; text: string }[]
}
