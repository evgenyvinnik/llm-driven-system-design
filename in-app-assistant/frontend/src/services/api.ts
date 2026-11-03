/**
 * Typed API client. Every call goes through `request`, which turns error
 * responses into `ApiError` with the server's code and details.
 */
import type {
  AdminOverview,
  AdminTurn,
  AdminTurnDetail,
  App,
  AssistantSettings,
  CalendarEvent,
  Citation,
  DocumentDetail,
  DocumentSummary,
  Draft,
  EvalRun,
  IndexStatus,
  MailMessage,
  MockModelSettings,
  OpenDocumentContext,
  TurnDto,
  TurnStep,
  User,
} from '@/types'

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message)
  }
}

interface RequestOptions {
  method?: string
  body?: unknown
  headers?: Record<string, string>
}

async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  let response: Response
  try {
    response = await fetch(`/api/v1${path}`, {
      method: opts.method ?? 'GET',
      credentials: 'same-origin',
      headers: { ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...opts.headers },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    })
  } catch {
    throw new ApiError(0, 'NETWORK', 'Could not reach the server')
  }
  if (response.status === 204) return undefined as T
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    const error = data?.error ?? {}
    throw new ApiError(response.status, error.code ?? 'HTTP_ERROR', error.message ?? response.statusText, error.details)
  }
  return data as T
}

export interface CreateTurnInput {
  conversationId?: string
  app: App
  text: string
  clientContext: { openDocument?: OpenDocumentContext; openMessage?: string }
}

export const api = {
  login: (username: string, password: string) => request<{ user: User }>('/auth/login', { method: 'POST', body: { username, password } }),
  logout: () => request<void>('/auth/logout', { method: 'POST' }),
  me: () => request<{ user: User }>('/auth/me'),

  messages: (folder: string) => request<{ messages: MailMessage[] }>(`/mail/messages?folder=${folder}`),
  message: (id: string) => request<{ message: MailMessage; thread: MailMessage[] }>(`/mail/messages/${id}`),
  drafts: () => request<{ drafts: Draft[] }>('/mail/drafts'),
  sendDraft: (id: string) => request<unknown>(`/mail/drafts/${id}/send`, { method: 'POST' }),
  discardDraft: (id: string) => request<void>(`/mail/drafts/${id}`, { method: 'DELETE' }),
  send: (body: { to: string[]; subject: string; body: string }) => request<unknown>('/mail/send', { method: 'POST', body }),

  documents: () => request<{ documents: DocumentSummary[] }>('/docs'),
  document: (id: string) => request<{ document: DocumentDetail }>(`/docs/${id}`),
  editParagraph: (id: string, pid: string, text: string, baseVersion: number) =>
    request<{ document: DocumentDetail }>(`/docs/${id}/paragraphs/${pid}`, { method: 'PATCH', body: { text, baseVersion } }),
  decideSuggestion: (id: string, pid: string, decision: 'accept' | 'reject') =>
    request<{ document: DocumentDetail }>(`/docs/${id}/paragraphs/${pid}/${decision}`, { method: 'POST' }),
  share: (id: string, principal: string, role: 'viewer' | 'editor' | null) =>
    request<{ document: DocumentDetail }>(`/docs/${id}/shares`, { method: 'PUT', body: { principal, role } }),

  events: (from: string, to: string) => request<{ from: string; to: string; timezone: string; events: CalendarEvent[] }>(`/calendar/events?from=${from}&to=${to}`),
  deleteEvent: (id: string) => request<void>(`/calendar/events/${id}`, { method: 'DELETE' }),

  settings: () => request<{ settings: AssistantSettings }>('/settings'),
  updateSettings: (patch: Partial<AssistantSettings>) => request<{ settings: AssistantSettings }>('/settings', { method: 'PUT', body: patch }),

  currentConversation: (app: App) => request<{ conversation: { id: string } | null; turns: TurnDto[] }>(`/assistant/conversations/current?app=${app}`),
  newConversation: (app: App) => request<{ conversation: { id: string } }>('/assistant/conversations', { method: 'POST', body: { app } }),
  /** The key makes a retried submit return the same turn instead of asking the model twice. */
  createTurn: (input: CreateTurnInput, idempotencyKey: string) =>
    request<{ turn: TurnDto; replayed: boolean }>('/assistant/turns', { method: 'POST', body: input, headers: { 'Idempotency-Key': idempotencyKey } }),
  turn: (id: string) => request<{ turn: TurnDto }>(`/assistant/turns/${id}`),
  turnSteps: (id: string) => request<{ steps: TurnStep[] }>(`/assistant/turns/${id}/steps`),
  toolResult: (turnId: string, body: { callId: string; output?: Record<string, unknown>; error?: string }) =>
    request<unknown>(`/assistant/turns/${turnId}/tool-results`, { method: 'POST', body }),
  cancelTurn: (id: string) => request<{ status: string }>(`/assistant/turns/${id}/cancel`, { method: 'POST' }),
  confirmAction: (id: string) => request<{ status: string }>(`/assistant/actions/${id}/confirm`, { method: 'POST' }),
  declineAction: (id: string) => request<{ status: string }>(`/assistant/actions/${id}/decline`, { method: 'POST' }),
  summarizeThread: (messageId: string) =>
    request<{ text: string; citations: Citation[]; usage: { inputTokens: number; outputTokens: number; latencyMs: number; model: string } }>('/assistant/quick', {
      method: 'POST',
      body: { action: 'summarize_thread', messageId },
    }),

  adminOverview: () => request<AdminOverview>('/admin/overview'),
  adminTurns: () => request<{ turns: AdminTurn[] }>('/admin/turns'),
  adminTurn: (id: string) => request<AdminTurnDetail>(`/admin/turns/${id}`),
  adminIndex: () => request<{ index: IndexStatus }>('/admin/index'),
  adminBackfill: () => request<{ queued: number }>('/admin/index/backfill', { method: 'POST' }),
  adminModel: () => request<{ provider: string; settings: MockModelSettings | null; chaosKinds?: string[] }>('/admin/model'),
  adminUpdateModel: (patch: Partial<MockModelSettings>) => request<{ settings: MockModelSettings }>('/admin/model', { method: 'PUT', body: patch }),
  adminEvals: () => request<{ run: EvalRun | null }>('/admin/evals'),
}
