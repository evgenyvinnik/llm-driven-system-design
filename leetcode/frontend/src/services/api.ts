const API_BASE = '/api/v1';

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
    throw new Error(error.error || 'Request failed');
  }

  return response.json();
}

// Auth API
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

// Problems API
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

// Submissions API
export const submissionsApi = {
  submit: (problemSlug: string, language: string, code: string) =>
    request<{ submissionId: string; status: string; message: string }>('/submissions', {
      method: 'POST',
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

  getStatus: (id: string) =>
    request<{
      status: string;
      runtime_ms?: number;
      memory_kb?: number;
      test_cases_passed: number;
      test_cases_total: number;
      error_message?: string;
      current_test?: number;
    }>(`/submissions/${id}/status`),
};

// Users API
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

// Admin API
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
