/**
 * Typed API client. Every call goes through `request`, which turns error
 * responses into `ApiError` with the server's code. Uploads are multipart and
 * carry an Idempotency-Key the caller keeps per file, so a retry can't create
 * a second document.
 */
import type {
  ChaosName,
  ChunkItem,
  DeletedItem,
  DocumentDetail,
  DocumentItem,
  DocumentText,
  EmbedderSettings,
  Group,
  ModelSettings,
  OpsOverview,
  OrgUser,
  Run,
  Scope,
  UploadResponse,
  User,
} from '@/types'

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message)
  }
}

interface RequestOpts {
  method?: string
  body?: unknown
  form?: FormData
  headers?: Record<string, string>
}

async function request<T>(path: string, opts: RequestOpts = {}): Promise<T> {
  let response: Response
  const json = opts.body !== undefined
  try {
    response = await fetch(`/api/v1${path}`, {
      method: opts.method ?? 'GET',
      credentials: 'same-origin',
      headers: { ...(json ? { 'Content-Type': 'application/json' } : {}), ...(opts.headers ?? {}) },
      body: opts.form ?? (json ? JSON.stringify(opts.body) : undefined),
    })
  } catch {
    throw new ApiError(0, 'NETWORK', 'Could not reach the server')
  }
  if (response.status === 204) return undefined as T
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    const error = data?.error ?? {}
    throw new ApiError(response.status, error.code ?? 'HTTP_ERROR', error.message ?? response.statusText)
  }
  return data as T
}

function fileForm(file: File): FormData {
  const form = new FormData()
  form.append('file', file, file.name)
  return form
}

export const api = {
  login: (username: string, password: string) => request<{ user: User }>('/auth/login', { method: 'POST', body: { username, password } }),
  logout: () => request<void>('/auth/logout', { method: 'POST' }),
  me: () => request<{ user: User }>('/auth/me'),

  documents: () => request<{ documents: DocumentItem[] }>('/documents'),
  deleted: () => request<{ documents: DeletedItem[] }>('/documents/deleted'),
  document: (id: string) => request<DocumentDetail>(`/documents/${id}`),
  text: (id: string, versionId?: string) => request<DocumentText>(`/documents/${id}/text${versionId ? `?version=${encodeURIComponent(versionId)}` : ''}`),
  chunks: (id: string, versionId?: string) =>
    request<{ chunks: ChunkItem[] }>(`/documents/${id}/chunks${versionId ? `?version=${encodeURIComponent(versionId)}` : ''}`),
  upload: (file: File, idempotencyKey: string) =>
    request<UploadResponse>('/documents', { method: 'POST', form: fileForm(file), headers: { 'Idempotency-Key': idempotencyKey } }),
  uploadVersion: (id: string, file: File, idempotencyKey: string) =>
    request<UploadResponse>(`/documents/${id}/versions`, { method: 'POST', form: fileForm(file), headers: { 'Idempotency-Key': idempotencyKey } }),
  share: (id: string, scope: Scope, groupId: string | null) =>
    request<{ document: DocumentItem; changed: boolean }>(`/documents/${id}/sharing`, { method: 'PATCH', body: { scope, groupId } }),
  remove: (id: string) => request<{ deleted: { id: string; title: string; deletedAt: string } }>(`/documents/${id}`, { method: 'DELETE' }),
  retry: (id: string) => request<{ document: DocumentItem }>(`/documents/${id}/retry`, { method: 'POST' }),

  groups: () => request<{ groups: Group[]; users: OrgUser[] }>('/groups'),
  addMember: (groupId: string, userId: string) => request<{ ok: boolean }>(`/groups/${groupId}/members`, { method: 'POST', body: { userId } }),
  removeMember: (groupId: string, userId: string) => request<{ removed: number }>(`/groups/${groupId}/members/${userId}`, { method: 'DELETE' }),

  runs: () => request<{ runs: Run[] }>('/answers'),
  run: (id: string) => request<{ run: Run }>(`/answers/${id}`),
  ask: (question: string) => request<{ run: Run }>('/answers', { method: 'POST', body: { question } }),
  cancel: (id: string) => request<{ cancelRequested: boolean }>(`/answers/${id}/cancel`, { method: 'POST' }),

  ops: () => request<OpsOverview>('/ops/overview'),
  retryJob: (id: string) => request<{ retried: number }>(`/ops/jobs/${id}/retry`, { method: 'POST' }),
  setChaos: (name: ChaosName, value: number) => request<{ chaos: Record<ChaosName, number> }>('/ops/chaos', { method: 'PUT', body: { name, value } }),
  setEmbedder: (patch: Record<string, unknown>) => request<EmbedderSettings>('/ops/embedder', { method: 'PUT', body: patch }),
  setModel: (patch: Record<string, unknown>) => request<ModelSettings>('/ops/model', { method: 'PUT', body: patch }),
}
