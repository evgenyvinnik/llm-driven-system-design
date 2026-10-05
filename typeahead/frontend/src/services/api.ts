import type {
  SuggestionsResponse,
  TrendingResponse,
  HistoryResponse,
  AnalyticsSummary,
  HourlyStats,
  TopPhrase,
  SystemStatus,
} from '../types';
import { v4 as uuidv4 } from 'uuid';
import { memoryCache } from './cache.js';
import { normalizePrefix } from '../utils/normalize.js';

const API_BASE = '/api/v1';
const DEFAULT_TIMEOUT = 5000; // 5 seconds

/**
 * Memory-cache key for a suggestions request. The prefix comes first and is JSON-encoded so
 * every cached variant of one prefix can be dropped with a single invalidatePrefix call.
 * userId is part of the key because the server's ranking is personalized.
 */
function suggestionsCacheKey(prefix: string, userId = '', limit = 5, fuzzy = false): string {
  return `suggestions:${JSON.stringify(prefix)}:${userId}:${limit}:${fuzzy}`;
}

/**
 * Fresh idempotency key for one user action. The backend deduplicates on X-Idempotency-Key,
 * so a repeated click must not reuse the previous key (or omit it) or it is replayed, not run.
 */
function newIdempotencyKey(): string {
  return uuidv4(); // crypto.randomUUID() where available, also works outside secure contexts
}

/**
 * Tell the service worker to drop its API cache after a mutation, or a filtered/added phrase
 * keeps being served from it.
 */
function clearServiceWorkerApiCache(): void {
  try {
    navigator.serviceWorker?.controller?.postMessage({ type: 'CLEAR_API_CACHE' });
  } catch {
    // No service worker (dev server, unsupported browser): nothing to clear
  }
}

/**
 * Drop the IndexedDB suggestion lists the /widgets typeaheads fall back to. Imported lazily so
 * the home page bundle doesn't pull in Dexie; best effort, like the service-worker clear.
 */
function clearIndexedDbSuggestionCache(): void {
  import('../db/database.js')
    .then((db) => db.clearSuggestionCache())
    .catch(() => {
      // IndexedDB unavailable (private mode, blocked storage): nothing to clear
    });
}

/** HTTP client for the typeahead API covering suggestions, trending, analytics, and admin endpoints. */
class ApiService {
  private abortControllers: Map<string, AbortController> = new Map();

  /**
   * Make an HTTP request with automatic timeout and abort handling.
   */
  private async request<T>(
    endpoint: string,
    options?: RequestInit & { signal?: AbortSignal }
  ): Promise<T> {
    // Merge rather than replace, so per-call headers (X-Idempotency-Key) keep the content type
    const headers = new Headers(options?.headers);
    if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');

    const response = await fetch(`${API_BASE}${endpoint}`, {
      ...options,
      headers,
    });

    if (!response.ok) {
      // Backend error bodies are { error: '...' } (validation text, 409 filter conflict)
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || body.message || `HTTP ${response.status}`);
    }

    return response.json();
  }

  /**
   * Cancel any pending requests for a given request group.
   * Used to abort previous suggestion requests when user types new characters.
   */
  private cancelPendingRequests(requestGroup: string): void {
    for (const [key, controller] of this.abortControllers.entries()) {
      if (key.startsWith(requestGroup)) {
        controller.abort();
        this.abortControllers.delete(key);
      }
    }
  }

  /**
   * Create a combined abort signal with timeout.
   */
  private createSignalWithTimeout(
    controller: AbortController,
    timeoutMs: number = DEFAULT_TIMEOUT
  ): AbortSignal {
    // Use AbortSignal.any if available (modern browsers)
    if ('any' in AbortSignal) {
      return AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)]);
    }

    // Fallback for older browsers: manual timeout. Abort with a TimeoutError so a timeout is
    // reported as a failure instead of being mistaken for a superseded (aborted) request.
    const timeoutId = setTimeout(
      () => controller.abort(new DOMException('signal timed out', 'TimeoutError')),
      timeoutMs
    );
    controller.signal.addEventListener('abort', () => clearTimeout(timeoutId));
    return controller.signal;
  }

  /**
   * Abort the in-flight suggestion request of one caller (input cleared, suggestion selected,
   * list dismissed). Callers must still ignore late results themselves: abort is an
   * optimization, not the ordering guarantee.
   */
  cancelSuggestions(group = 'default'): void {
    this.cancelPendingRequests(`suggestions:${group}:`);
  }

  /**
   * Drop memory-cached suggestions for every prefix of a phrase, since a logged search changes
   * that phrase's personalized ranking under each of them.
   */
  private invalidateSuggestionsFor(phrase: string): void {
    const normalized = phrase.toLowerCase().trim();
    for (let i = 1; i <= normalized.length; i++) {
      memoryCache.invalidatePrefix(`suggestions:${JSON.stringify(normalized.slice(0, i))}:`);
    }
  }

  // Suggestions. `group` scopes cancellation to one input: a new request aborts only the
  // previous request of the same group, so two typeahead instances never cancel each other.
  async getSuggestions(
    prefix: string,
    options: {
      limit?: number;
      userId?: string;
      fuzzy?: boolean;
      group?: string;
      /** Called when the lookup goes to the network (not on a memory-cache hit). */
      onRequestSent?: () => void;
    } = {}
  ): Promise<SuggestionsResponse> {
    // meta.clientLatencyMs times the lookup alone, so a caller's render work isn't counted
    const startedAt = performance.now();
    const requestGroup = `suggestions:${options.group ?? 'default'}:`;
    const cacheKey = suggestionsCacheKey(
      normalizePrefix(prefix),
      options.userId,
      options.limit || 5,
      options.fuzzy || false
    );

    // Cancel this group's pending request first, so an older in-flight response cannot
    // land after this one even when this one is answered from memory
    this.cancelPendingRequests(requestGroup);

    // Check memory cache
    const cached = memoryCache.get<SuggestionsResponse>(cacheKey);
    if (cached) {
      return {
        ...cached,
        meta: {
          ...cached.meta,
          cached: true,
          clientCache: true,
          clientLatencyMs: performance.now() - startedAt,
        },
      };
    }

    // Create new abort controller for this request
    const controller = new AbortController();
    const requestKey = `${requestGroup}${prefix}`;
    this.abortControllers.set(requestKey, controller);

    try {
      const params = new URLSearchParams({
        q: prefix,
        limit: String(options.limit || 5),
      });

      if (options.userId) {
        params.append('userId', options.userId);
      }

      if (options.fuzzy) {
        params.append('fuzzy', 'true');
      }

      const signal = this.createSignalWithTimeout(controller);
      options.onRequestSent?.();

      const response = await this.request<SuggestionsResponse>(`/suggestions?${params}`, {
        signal,
        // Personalized responses change as soon as this user logs a search; revalidate them
        // (ETag, so usually a 304) instead of letting the HTTP cache answer for minutes.
        cache: options.userId ? 'no-cache' : 'default',
      });

      // Cache the response, unless it is a circuit-breaker fallback (an empty list that would
      // otherwise hide real suggestions for a minute after the backend recovers)
      if (!response.meta?.degraded) {
        memoryCache.set(cacheKey, response, 60_000); // 60s TTL
      }

      return { ...response, meta: { ...response.meta, clientLatencyMs: performance.now() - startedAt } };
    } finally {
      // Only remove our own controller; a newer request may already own this key
      if (this.abortControllers.get(requestKey) === controller) {
        this.abortControllers.delete(requestKey);
      }
    }
  }

  async logSearch(query: string, userId?: string, sessionId?: string): Promise<void> {
    // Invalidate now so retyping refetches, and again once the server has recorded the
    // search, so a response fetched while the log was in flight is not kept
    this.invalidateSuggestionsFor(query);

    try {
      await this.request('/suggestions/log', {
        method: 'POST',
        body: JSON.stringify({ query, userId, sessionId }),
      });
    } finally {
      this.invalidateSuggestionsFor(query);
    }
  }

  async getTrending(limit = 10): Promise<TrendingResponse> {
    const cacheKey = `trending:${limit}`;

    // Check memory cache
    const cached = memoryCache.get<TrendingResponse>(cacheKey);
    if (cached) {
      return cached;
    }

    const response = await this.request<TrendingResponse>(`/suggestions/trending?limit=${limit}`);

    // Cache with shorter TTL for trending (30s)
    memoryCache.set(cacheKey, response, 30_000);

    return response;
  }

  async getHistory(userId: string, limit = 10): Promise<HistoryResponse> {
    // User-specific data - don't cache in shared memory
    return this.request<HistoryResponse>(
      `/suggestions/history?userId=${encodeURIComponent(userId)}&limit=${limit}`
    );
  }

  // Analytics. Admin dashboard data is not memory-cached: the dashboard polls for live numbers,
  // and the server sends 'private, no-cache' + ETag, so an unchanged poll is a cheap 304.
  async getAnalyticsSummary(): Promise<AnalyticsSummary> {
    return this.request<AnalyticsSummary>('/analytics/summary', { cache: 'no-cache' });
  }

  async getHourlyStats(): Promise<{ hourly: HourlyStats[] }> {
    return this.request<{ hourly: HourlyStats[] }>('/analytics/hourly', { cache: 'no-cache' });
  }

  async getTopPhrases(limit = 50): Promise<{ phrases: TopPhrase[]; meta: { count: number } }> {
    return this.request<{ phrases: TopPhrase[]; meta: { count: number } }>(
      `/analytics/top-phrases?limit=${limit}`,
      { cache: 'no-cache' }
    );
  }

  // Admin
  async getSystemStatus(): Promise<SystemStatus> {
    // Don't cache admin status - always fresh
    return this.request<SystemStatus>('/admin/status');
  }

  /**
   * POST an admin mutation with a fresh idempotency key, then drop every client-side copy of
   * suggestions (memory cache and service worker). Fuzzy results can contain a phrase under
   * prefixes it does not start with, so mutations invalidate all suggestion entries.
   */
  private async adminMutation<T>(endpoint: string, body?: unknown): Promise<T> {
    try {
      return await this.request<T>(endpoint, {
        method: 'POST',
        headers: { 'X-Idempotency-Key': newIdempotencyKey() },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } finally {
      memoryCache.invalidatePrefix('suggestions:');
      clearServiceWorkerApiCache();
      clearIndexedDbSuggestionCache();
    }
  }

  async rebuildTrie(): Promise<{ success: boolean; message: string; stats: unknown }> {
    return this.adminMutation('/admin/trie/rebuild');
  }

  async clearCache(): Promise<{ success: boolean; message: string }> {
    // Clear local cache too
    memoryCache.clear();

    return this.adminMutation('/admin/cache/clear');
  }

  /**
   * Add a phrase, or raise an existing phrase's count. count in the response is the stored
   * count (adding never lowers one); restored means a removed phrase is back in suggestions.
   */
  async addPhrase(
    phrase: string,
    count = 1
  ): Promise<{
    success: boolean;
    message: string;
    phrase: string;
    count: number;
    requestedCount: number;
    created: boolean;
    previousCount: number | null;
    restored: boolean;
  }> {
    return this.adminMutation('/admin/phrases', { phrase, count });
  }

  async filterPhrase(phrase: string, reason = 'manual'): Promise<{ success: boolean; phrase: string }> {
    return this.adminMutation('/admin/filter', { phrase, reason });
  }

  async getFilteredPhrases(limit = 100): Promise<{
    filtered: Array<{ phrase: string; reason: string; added_at: string }>;
    meta: { count: number };
  }> {
    return this.request(`/admin/filtered?limit=${limit}`);
  }

  /**
   * Clear the in-memory cache.
   */
  clearLocalCache(): void {
    memoryCache.clear();
  }

  /**
   * Get cache statistics.
   */
  getCacheStats(): { size: number; maxSize: number; defaultTtl: number } {
    return memoryCache.getStats();
  }
}

export const api = new ApiService();
