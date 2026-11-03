/** Shapes returned by the API. Kept in sync with backend/src/api/services/serialize.ts. */

export interface User {
  id: string
  username: string
  displayName: string
  role: 'user' | 'admin'
}

export interface ModelInfo {
  id: string
  label: string
  description: string
  contextTokens: number
}

export interface Conversation {
  id: string
  title: string
  model: string
  currentLeafId: string | null
  activeGenerationId: string | null
  createdAt: string
  updatedAt: string
}

export type GenerationStatus = 'accepted' | 'running' | 'completed' | 'cancelled' | 'failed'

export const isTerminal = (status: GenerationStatus) =>
  status === 'completed' || status === 'cancelled' || status === 'failed'

export interface GenerationUsage {
  inputTokens: number | null
  outputTokens: number | null
  queueMs: number | null
  ttftMs: number | null
  durationMs: number | null
}

export interface Generation {
  id: string
  conversationId: string
  userMessageId: string
  assistantMessageId: string
  kind: 'message' | 'edit' | 'regenerate'
  model: string
  status: GenerationStatus
  /** Output as of checkpointEventId while running; final output once ended. */
  output: string
  checkpointEventId: string | null
  outputTruncated: boolean
  finishReason: string | null
  errorCode: string | null
  errorMessage: string | null
  usage: GenerationUsage
  contextMessages: number | null
  contextDropped: number | null
  cancelRequested: boolean
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
  conversationTitle?: string
}

export interface Message {
  id: string
  conversationId: string
  parentId: string | null
  role: 'user' | 'assistant'
  content: string
  depth: number
  createdAt: string
  /** Children of the same parent, oldest first; this message's position drives "‹ 2/3 ›". */
  siblingIds: string[]
  generation: Generation | null
}

export interface ThreadPage {
  messages: Message[]
  hasMoreBefore: boolean
}

export interface ConversationView extends ThreadPage {
  conversation: Conversation
}

/** The response to every POST that asks the model for an answer (new chat, message, edit, regenerate). */
export interface GenerationResult {
  conversation: Conversation
  userMessage: Message
  assistantMessage: Message
  generation: Generation
}

export interface EndEvent {
  status: 'completed' | 'cancelled' | 'failed'
  outputTruncated: boolean
  finishReason: string | null
  errorCode: string | null
  errorMessage: string | null
  usage: GenerationUsage
  at: string
}

export interface ModelSettings {
  ttftMsOverride: number | null
  tokensPerSecondOverride: number | null
  failureRateOverride: number | null
  disconnectRate: number
  maxConcurrent: number
}

export interface AdminOverview {
  statusCounts: Record<string, number>
  models: {
    model: string
    generations: number
    failed: number
    cancelled: number
    ttftP50Ms: number | null
    ttftP95Ms: number | null
    durationP95Ms: number | null
    outputTokens: number
  }[]
  recent: {
    id: string
    status: GenerationStatus
    kind: string
    model: string
    outputTokens: number | null
    errorCode: string | null
    ttftMs: number | null
    user: string
    conversationTitle: string
    createdAt: string
  }[]
}
