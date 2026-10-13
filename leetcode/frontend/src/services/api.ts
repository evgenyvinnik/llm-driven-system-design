const API_BASE = '/api/v1';

/** Non-2xx response from the API; `status` lets callers tell client errors from server errors. */
export class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/** Error thrown when API returns 429, includes retry-after seconds for backoff. */
export class RateLimitError extends ApiError {
  retryAfter: number;

  constructor(message: string, retryAfter: number) {
    super(message, 429);
    this.name = 'RateLimitError';
    this.retryAfter = retryAfter;
  }
}

async function request<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const response = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
    credentials: 'include',
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Request failed' }));

    // Handle rate limiting specifically
    if (response.status === 429) {
      const retryAfter = error.retryAfter || parseInt(response.headers.get('Retry-After') || '60', 10);
      throw new RateLimitError(error.message || 'Rate limit exceeded. Please wait before trying again.', retryAfter);
    }

    throw new ApiError(error.error || 'Request failed', response.status);
  }

  return response.json();
}

/**
 * A new Idempotency-Key for one submit attempt. crypto.randomUUID only exists in secure
 * contexts (https or localhost), so fall back to getRandomValues for other dev hosts.
 */
export function newIdempotencyKey(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Authentication API methods for login, registration, logout, and session validation. */
export const authApi = {
  login: (username: string, password: string) =>
    request<{ user: { id: string; username: string; email: string; role: string } }>(
      '/auth/login',
      {
        method: 'POST',
        body: JSON.stringify({ username, password }),
      }
    ),

  register: (username: string, email: string, password: string) =>
    request<{ user: { id: string; username: string; email: string; role: string } }>(
      '/auth/register',
      {
        method: 'POST',
        body: JSON.stringify({ username, email, password }),
      }
    ),

  logout: () =>
    request<{ message: string }>('/auth/logout', {
      method: 'POST',
    }),

  me: () =>
    request<{ user: { id: string; username: string; role: string } }>('/auth/me'),
};

/** Problems API for listing, fetching details, and retrieving submission history per problem. */
export const problemsApi = {
  list: (params?: { difficulty?: string; search?: string; page?: number; limit?: number }) => {
    const searchParams = new URLSearchParams();
    if (params?.difficulty) searchParams.set('difficulty', params.difficulty);
    if (params?.search) searchParams.set('search', params.search);
    if (params?.page) searchParams.set('page', params.page.toString());
    if (params?.limit) searchParams.set('limit', params.limit.toString());
    const query = searchParams.toString();
    return request<{
      problems: Array<{
        id: string;
        title: string;
        slug: string;
        difficulty: 'easy' | 'medium' | 'hard';
        userStatus?: 'solved' | 'attempted' | 'unsolved';
      }>;
      pagination: { total: number; page: number; limit: number; pages: number };
    }>(`/problems${query ? `?${query}` : ''}`);
  },

  get: (slug: string) =>
    request<{
      id: string;
      title: string;
      slug: string;
      description: string;
      examples: string;
      constraints: string;
      difficulty: 'easy' | 'medium' | 'hard';
      time_limit_ms: number;
      memory_limit_mb: number;
      starter_code_python: string;
      starter_code_javascript: string;
      sampleTestCases: Array<{ id: string; input: string; expected_output: string; order_index: number }>;
      accepted_count: number;
      total_submissions: number;
      userStatus?: { status: string; best_runtime_ms?: number; attempts: number };
    }>(`/problems/${slug}`),

  getSubmissions: (slug: string) =>
    request<{
      submissions: Array<{
        id: string;
        language: string;
        status: string;
        runtime_ms: number | null;
        memory_kb: number | null;
        test_cases_passed: number;
        test_cases_total: number;
        created_at: string;
      }>;
    }>(`/problems/${slug}/submissions`),
};

/** Submissions API for submitting code, running against test cases, and polling execution status. */
export const submissionsApi = {
  /** The same key must be sent on every retry of one submit attempt; the server dedupes on it. */
  submit: (problemSlug: string, language: string, code: string, idempotencyKey: string) =>
    request<{ submissionId: string; status: string; message: string; duplicate?: boolean }>('/submissions', {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify({ problemSlug, language, code }),
    }),

  run: (problemSlug: string, language: string, code: string, customInput?: string) =>
    request<{
      results: Array<{
        input: string;
        expectedOutput: string | null;
        actualOutput: string | null;
        status: string;
        passed: boolean | null;
        executionTime: number;
        error: string | null;
      }>;
    }>('/submissions/run', {
      method: 'POST',
      body: JSON.stringify({ problemSlug, language, code, customInput }),
    }),

  get: (id: string) =>
    request<{
      id: string;
      status: string;
      runtime_ms: number | null;
      memory_kb: number | null;
      test_cases_passed: number;
      test_cases_total: number;
      error_message: string | null;
      code?: string;
      language: string;
      created_at: string;
      problem_slug: string;
      problem_title: string;
    }>(`/submissions/${id}`),

  getStatus: (id: string, signal?: AbortSignal) =>
    request<SubmissionStatusResponse>(`/submissions/${id}/status`, { signal }),
};

export interface SubmissionStatusResponse {
  status: string;
  runtime_ms?: number | null;
  memory_kb?: number | null;
  test_cases_passed?: number;
  test_cases_total?: number;
  error_message?: string | null;
  current_test?: number;
}

/** Users API for profiles, submission history, and problem-solving progress tracking. */
export const usersApi = {
  getProfile: (id: string) =>
    request<{
      user: { id: string; username: string; created_at: string };
      stats: {
        solved_count: string;
        attempted_count: string;
        total_submissions: string;
        accepted_submissions: string;
        difficultyBreakdown: { easy: number; medium: number; hard: number };
      };
    }>(`/users/${id}/profile`),

  getSubmissions: (id: string, page?: number) =>
    request<{
      submissions: Array<{
        id: string;
        language: string;
        status: string;
        runtime_ms: number | null;
        test_cases_passed: number;
        test_cases_total: number;
        created_at: string;
        problem_title: string;
        problem_slug: string;
        difficulty: string;
      }>;
      pagination: { total: number; page: number; limit: number };
    }>(`/users/${id}/submissions${page ? `?page=${page}` : ''}`),

  getProgress: () =>
    request<{
      progress: Array<{
        problem_id: string;
        slug: string;
        title: string;
        difficulty: 'easy' | 'medium' | 'hard';
        status: 'solved' | 'attempted' | 'unsolved';
        attempts: number;
        best_runtime_ms: number | null;
      }>;
      totals: { easy: number; medium: number; hard: number };
    }>('/users/me/progress'),
};

/** Admin API for platform statistics, leaderboard rankings, and system health monitoring. */
export const adminApi = {
  getStats: () =>
    request<{
      overview: {
        total_users: string;
        total_problems: string;
        total_submissions: string;
        accepted_submissions: string;
        submissions_24h: string;
        new_users_24h: string;
      };
      submissionsByStatus: Array<{ status: string; count: string }>;
      problemsByDifficulty: Array<{ difficulty: string; count: string }>;
    }>('/admin/stats'),

  getUsers: (page?: number, search?: string) => {
    const params = new URLSearchParams();
    if (page) params.set('page', page.toString());
    if (search) params.set('search', search);
    const query = params.toString();
    return request<{
      users: Array<{
        id: string;
        username: string;
        email: string;
        role: string;
        created_at: string;
        submission_count: string;
        solved_count: string;
      }>;
      pagination: { total: number; page: number; limit: number };
    }>(`/admin/users${query ? `?${query}` : ''}`);
  },

  getLeaderboard: () =>
    request<{
      leaderboard: Array<{
        id: string;
        username: string;
        solved_count: string;
        easy_solved: string;
        medium_solved: string;
        hard_solved: string;
        avg_runtime: string;
      }>;
    }>('/admin/leaderboard'),
};
