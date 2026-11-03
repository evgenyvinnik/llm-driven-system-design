/**
 * Typed API client. Every call goes through `request`, which turns error
 * responses into `ApiError` with the server's code and details, and reports
 * reachability to the connectivity store (a network failure flips the app
 * into offline, read-only mode; any response flips it back).
 */
import { useConnectivity } from '@/stores/connectivity-store'
import type {
  AdminOverview,
  Conversation,
  ConversationView,
  Generation,
  GenerationResult,
  ModelInfo,
  ModelSettings,
  ThreadPage,
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

/** The request's outcome is unknown: it failed to connect, or a gateway answered instead of the API. */
export const isNetworkError = (err: unknown) => err instanceof ApiError && err.status === 0

interface RequestOptions {
  method?: string
  body?: unknown
  headers?: Record<string, string>
  signal?: AbortSignal
}

async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  let response: Response
  try {
    response = await fetch(`/api/v1${path}`, {
      method: opts.method ?? 'GET',
      credentials: 'same-origin',
      headers: { ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...opts.headers },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: opts.signal,
    })
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err
    useConnectivity.getState().reportUnreachable()
    throw new ApiError(0, 'NETWORK', 'Could not reach the server')
  }
  if (response.status === 204) {
    useConnectivity.getState().reportReachable()
    return undefined as T
  }
  const data = await response.json().catch(() => null)
  // A gateway error (502/503/504, or a 5xx without our error envelope, as a dev proxy sends when the
  // API is down) means the request may or may not have reached the API: same as a dropped connection.
  if (response.status >= 500 && (response.status >= 502 || !data?.error)) {
    useConnectivity.getState().reportUnreachable()
    throw new ApiError(0, 'UNREACHABLE', 'The server is not reachable')
  }
  useConnectivity.getState().reportReachable()
  if (!response.ok) {
    const error = data?.error ?? {}
    throw new ApiError(response.status, error.code ?? 'HTTP_ERROR', error.message ?? response.statusText, error.details)
  }
  return data as T
}

const key = (idempotencyKey: string) => ({ 'Idempotency-Key': idempotencyKey })

export const api = {
  login: (username: string, password: string) =>
    request<{ user: User }>('/auth/login', { method: 'POST', body: { username, password } }),
  logout: () => request<void>('/auth/logout', { method: 'POST' }),
  me: () => request<{ user: User }>('/auth/me'),
  models: () => request<{ models: ModelInfo[] }>('/models'),

  listConversations: (cursor?: string) =>
    request<{ conversations: Conversation[]; nextCursor: string | null }>(
      `/conversations?limit=30${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
    ),
  getConversation: (id: string) => request<ConversationView>(`/conversations/${id}`),
  olderMessages: (id: string, beforeId: string) =>
    request<ThreadPage>(`/conversations/${id}/messages?before=${beforeId}`),
  renameConversation: (id: string, title: string) =>
    request<{ conversation: Conversation }>(`/conversations/${id}`, { method: 'PATCH', body: { title } }),
  deleteConversation: (id: string) => request<void>(`/conversations/${id}`, { method: 'DELETE' }),
  switchBranch: (id: string, messageId: string) =>
    request<ConversationView>(`/conversations/${id}/leaf`, { method: 'PUT', body: { messageId } }),

  /** The key makes a retried Send return the same generation instead of asking for a second answer. */
  createConversation: (body: { content: string; model?: string }, idempotencyKey: string) =>
    request<GenerationResult>('/conversations', { method: 'POST', body, headers: key(idempotencyKey) }),
  sendMessage: (
    conversationId: string,
    body: { content: string; parentMessageId: string | null; editOfMessageId?: string; model?: string },
    idempotencyKey: string,
  ) =>
    request<GenerationResult>(`/conversations/${conversationId}/messages`, {
      method: 'POST',
      body,
      headers: key(idempotencyKey),
    }),
  regenerate: (conversationId: string, userMessageId: string, idempotencyKey: string, model?: string) =>
    request<GenerationResult>(`/conversations/${conversationId}/messages/${userMessageId}/regenerate`, {
      method: 'POST',
      body: model ? { model } : {},
      headers: key(idempotencyKey),
    }),

  getGeneration: (id: string) => request<{ generation: Generation }>(`/generations/${id}`),
  activeGenerations: () => request<{ generations: Generation[] }>('/generations/active'),
  cancelGeneration: (id: string) => request<{ generation: Generation }>(`/generations/${id}/cancel`, { method: 'POST' }),

  adminOverview: () => request<AdminOverview>('/admin/overview'),
  modelSettings: () =>
    request<{ settings: ModelSettings; active: number; streamDropAfterEvents: number }>('/admin/model-settings'),
  updateModelSettings: (body: Partial<ModelSettings>) =>
    request<{ settings: ModelSettings; active: number; streamDropAfterEvents: number }>('/admin/model-settings', {
      method: 'PUT',
      body,
    }),
  setStreamDrop: (afterEvents: number) =>
    request<{ streamDropAfterEvents: number }>('/admin/stream-drop', { method: 'PUT', body: { afterEvents } }),
}
