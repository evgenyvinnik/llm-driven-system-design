/**
 * Typed client for the file-system API. Every non-2xx response becomes an
 * ApiError carrying the server's error code (PATH_EXISTS, OVER_CAPACITY, ...).
 */
import type { DirListing, LargestFile, RestoreResult, StoreKind, UserSummary } from '@/types'

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message)
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const data = await res.json().catch(() => null)
  if (!res.ok) {
    const error = data?.error ?? { code: 'HTTP_ERROR', message: `Request failed (${res.status})` }
    throw new ApiError(res.status, error.code, error.message)
  }
  return data as T
}

const q = (params: Record<string, string | number>) => new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString()

export const api = {
  info: () => request<{ store: StoreKind }>('GET', '/api/v1/info'),

  list: (path: string) => request<DirListing>('GET', `/api/v1/fs/list?${q({ path })}`),
  largest: (prefix: string, n: number) => request<{ prefix: string; files: LargestFile[] }>('GET', `/api/v1/fs/largest?${q({ prefix, n })}`),
  addFile: (path: string, size: number, owner: string | null) =>
    request<{ path: string; size: number; owner: string | null; remaining: number | null }>('POST', '/api/v1/fs/files', { path, size, owner }),
  updateFile: (path: string, size: number) => request<{ path: string; size: number; previous: number }>('PATCH', `/api/v1/fs/files?${q({ path })}`, { size }),
  deleteFile: (path: string) => request<{ path: string; size: number }>('DELETE', `/api/v1/fs/files?${q({ path })}`),

  users: () => request<{ users: UserSummary[] }>('GET', '/api/v1/users'),
  addUser: (id: string, capacity: number) => request<{ id: string; capacity: number }>('POST', '/api/v1/users', { id, capacity }),
  mergeUsers: (targetId: string, sourceId: string) =>
    request<{ targetId: string; sourceId: string; remaining: number }>('POST', `/api/v1/users/${encodeURIComponent(targetId)}/merge`, { sourceId }),
  backupUser: (id: string) => request<{ id: string; fileCount: number }>('POST', `/api/v1/users/${encodeURIComponent(id)}/backup`),
  restoreUser: (id: string) => request<RestoreResult>('POST', `/api/v1/users/${encodeURIComponent(id)}/restore`),
  reset: () => request<{ status: string }>('POST', '/api/v1/admin/reset'),
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong'
}
