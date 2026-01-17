/**
 * API client for interacting with backend services
 * @module api/client
 */

const BASE_URL = '/api'

/**
 * Get stored session ID from localStorage
 */
function getSessionId(): string | null {
  return localStorage.getItem('sessionId')
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
    throw new Error(error.error || 'Request failed')
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

export function logout(): void {
  localStorage.removeItem('sessionId')
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
  book_title?: string
  book_author?: string
}

export interface CreateHighlightParams {
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
    body: JSON.stringify(params),
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
  updates: { note?: string; color?: string; visibility?: string }
): Promise<Highlight> {
  return request<Highlight>(`/highlights/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(updates),
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
  highlight_count: number
  location_start: number
  location_end: number
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
