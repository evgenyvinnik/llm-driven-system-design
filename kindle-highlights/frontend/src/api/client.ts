/**
 * API client for interacting with backend services
 * @module api/client
 */

const BASE_URL = '/api'

/**
 * Get stored session ID from localStorage
 */
export function getSessionId(): string | null {
  return localStorage.getItem('sessionId')
}

/**
 * This browser's device id. The server stamps edits with it (last-writer-wins tie-breaks)
 * and uses it to skip poking the device that made a change.
 */
export function getDeviceId(): string {
  let id = localStorage.getItem('deviceId')
  if (!id) {
    id = `web-${crypto.randomUUID()}`
    localStorage.setItem('deviceId', id)
  }
  return id
}

/** An HTTP error from the API, with its status so callers can tell 4xx from network failures. */
export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

/**
 * Make authenticated API request
 */
async function request<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const sessionId = getSessionId()
  const headers: HeadersInit = {
    'Content-Type': 'application/json',
    'X-Device-Id': getDeviceId(),
    ...options.headers,
  }

  if (sessionId) {
    ;(headers as Record<string, string>)['Authorization'] = `Bearer ${sessionId}`
  }

  const response = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers,
  })

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Request failed' }))
    throw new ApiError(error.error || 'Request failed', response.status)
  }

  if (response.status === 204) {
    return undefined as T
  }

  return response.json()
}

// ==================== Auth ====================

export interface User {
  id: string
  email: string
  username: string
  avatar_url?: string
  bio?: string
}

export async function register(
  email: string,
  username: string,
  password: string
): Promise<{ userId: string; sessionId: string }> {
  const result = await request<{ userId: string; sessionId: string }>(
    '/auth/register',
    {
      method: 'POST',
      body: JSON.stringify({ email, username, password }),
    }
  )
  localStorage.setItem('sessionId', result.sessionId)
  return result
}

export async function login(
  email: string,
  password: string
): Promise<{ userId: string; username: string; sessionId: string }> {
  const result = await request<{ userId: string; username: string; sessionId: string }>(
    '/auth/login',
    {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }
  )
  localStorage.setItem('sessionId', result.sessionId)
  return result
}

export async function getMe(): Promise<User> {
  return request<User>('/auth/me')
}

/** Revokes the session on the server (best effort), then forgets it locally. */
export async function logout(): Promise<void> {
  try {
    if (getSessionId()) await request<void>('/auth/logout', { method: 'POST' })
  } catch {
    // An expired or already-revoked session is fine; the local token goes either way.
  } finally {
    localStorage.removeItem('sessionId')
  }
}

// ==================== Highlights ====================

export interface Highlight {
  id: string
  user_id: string
  book_id: string
  location_start: number
  location_end: number
  highlighted_text: string
  note: string | null
  color: string
  visibility: string
  created_at: string
  updated_at: string
  /** Position of this highlight's latest change in the owner's change feed. */
  sync_seq?: number
  /** Set when the highlight was deleted (a tombstone). */
  deleted_at?: string | null
  book_title?: string
  book_author?: string
}

export interface CreateHighlightParams {
  /** Minted on the device; retrying with the same id can never create a duplicate. */
  id?: string
  bookId: string
  locationStart: number
  locationEnd: number
  text: string
  note?: string
  color?: string
  visibility?: string
}

export async function createHighlight(params: CreateHighlightParams): Promise<Highlight> {
  return request<Highlight>('/highlights', {
    method: 'POST',
    body: JSON.stringify({ id: crypto.randomUUID(), clientUpdatedAt: Date.now(), ...params }),
  })
}

export async function getHighlights(params?: {
  bookId?: string
  search?: string
  limit?: number
  offset?: number
}): Promise<Highlight[]> {
  const searchParams = new URLSearchParams()
  if (params?.bookId) searchParams.set('bookId', params.bookId)
  if (params?.search) searchParams.set('search', params.search)
  if (params?.limit) searchParams.set('limit', String(params.limit))
  if (params?.offset) searchParams.set('offset', String(params.offset))

  const query = searchParams.toString()
  return request<Highlight[]>(`/highlights${query ? `?${query}` : ''}`)
}

export async function updateHighlight(
  id: string,
  updates: { note?: string | null; color?: string; visibility?: string }
): Promise<Highlight> {
  return request<Highlight>(`/highlights/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ ...updates, clientUpdatedAt: Date.now() }),
  })
}

export async function deleteHighlight(id: string): Promise<void> {
  return request<void>(`/highlights/${id}`, { method: 'DELETE' })
}

export async function exportHighlights(format: 'markdown' | 'csv' | 'json'): Promise<string> {
  const response = await fetch(`${BASE_URL}/export/highlights?format=${format}`, {
    headers: {
      Authorization: `Bearer ${getSessionId()}`,
    },
  })
  if (!response.ok) {
    // Without this check an error body would be offered to the user as their export file
    const error = await response.json().catch(() => ({ error: 'Export failed' }))
    throw new ApiError(error.error || 'Export failed', response.status)
  }
  return response.text()
}

// ==================== Library ====================

export interface Book {
  id: string
  title: string
  author: string
  isbn?: string
  cover_url?: string
  description?: string
  highlight_count?: number
  last_highlighted?: string
}

export async function getLibrary(): Promise<Book[]> {
  return request<Book[]>('/library')
}

// ==================== Popular Highlights ====================

export interface PopularHighlight {
  passage_id: string
  passage_text: string
  /** Distinct readers; passages below the privacy threshold are never returned. */
  reader_count: number
  location_start: number
  location_end: number
  last_contribution_at?: string | null
  book_id?: string
  book_title?: string
  book_author?: string
}

export async function getPopularHighlights(
  bookId: string,
  params?: { limit?: number; minCount?: number }
): Promise<PopularHighlight[]> {
  const searchParams = new URLSearchParams()
  if (params?.limit) searchParams.set('limit', String(params.limit))
  if (params?.minCount) searchParams.set('minCount', String(params.minCount))

  const query = searchParams.toString()
  return request<PopularHighlight[]>(
    `/books/${bookId}/popular${query ? `?${query}` : ''}`
  )
}

export async function getTrending(params?: {
  limit?: number
  days?: number
}): Promise<PopularHighlight[]> {
  const searchParams = new URLSearchParams()
  if (params?.limit) searchParams.set('limit', String(params.limit))
  if (params?.days) searchParams.set('days', String(params.days))

  const query = searchParams.toString()
  return request<PopularHighlight[]>(`/trending${query ? `?${query}` : ''}`)
}

export async function getHeatmap(bookId: string): Promise<Record<string, number>> {
  return request<Record<string, number>>(`/books/${bookId}/heatmap`)
}

// ==================== Social ====================

export interface UserProfile {
  id: string
  username: string
  avatar_url?: string
  bio?: string
  followers_count: number
  following_count: number
  public_highlights_count: number
}

export async function getUserProfile(userId: string): Promise<UserProfile> {
  return request<UserProfile>(`/users/${userId}`)
}

export async function followUser(userId: string): Promise<void> {
  return request<void>(`/users/${userId}/follow`, { method: 'POST' })
}

export async function unfollowUser(userId: string): Promise<void> {
  return request<void>(`/users/${userId}/follow`, { method: 'DELETE' })
}

export async function getFollowing(): Promise<
  { id: string; username: string; avatar_url?: string }[]
> {
  return request('/following')
}

export async function getFollowers(): Promise<
  { id: string; username: string; avatar_url?: string }[]
> {
  return request('/followers')
}

export async function getFriendsHighlights(bookId: string): Promise<Highlight[]> {
  return request<Highlight[]>(`/books/${bookId}/friends-highlights`)
}

export async function shareHighlight(
  highlightId: string,
  platform: string
): Promise<{ text: string; url: string }> {
  return request<{ text: string; url: string }>(`/highlights/${highlightId}/share`, {
    method: 'POST',
    body: JSON.stringify({ platform }),
  })
}

// ==================== Sync ====================

/** One entry of this device's outbox (see sync/outbox.ts). */
export type SyncOp =
  | { opId: string; kind: 'update'; id: string; changes: { note?: string | null; color?: string; visibility?: string }; clientUpdatedAt: number }
  | { opId: string; kind: 'delete'; id: string; clientUpdatedAt: number }

/** The server's verdict on one pushed operation. Every status is final for that operation. */
export interface SyncOpResult {
  opId: string | null
  id?: string
  status: 'created' | 'replayed' | 'applied' | 'superseded' | 'unchanged' | 'deleted' | 'gone' | 'not_found' | 'rejected'
  highlight?: Highlight
  error?: string
}

/** Applies a batch of offline operations, in order. Safe to retry with the same batch. */
export async function pushOps(ops: SyncOp[]): Promise<{ results: SyncOpResult[] }> {
  return request<{ results: SyncOpResult[] }>('/sync/push', {
    method: 'POST',
    body: JSON.stringify({ ops }),
  })
}

/** The caller's changes after `since` (a cursor from a previous call), oldest first. */
export async function getChanges(
  since: number,
  limit = 200
): Promise<{ changes: Highlight[]; cursor: number; hasMore: boolean; resync: boolean }> {
  return request(`/sync/changes?since=${since}&limit=${limit}`)
}
