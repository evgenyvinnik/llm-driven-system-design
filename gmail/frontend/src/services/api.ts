const API_BASE = '/api/v1';

/** Sends an authenticated fetch request to the Gmail backend API with credential forwarding. */
async function fetchApi<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
    credentials: 'include',
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }

  return response.json();
}

// Auth API
export const authApi = {
  register: (data: {
    username: string;
    email: string;
    password: string;
    displayName?: string;
  }) => fetchApi('/auth/register', { method: 'POST', body: JSON.stringify(data) }),

  login: (data: { username: string; password: string }) =>
    fetchApi('/auth/login', { method: 'POST', body: JSON.stringify(data) }),

  logout: () => fetchApi('/auth/logout', { method: 'POST' }),

  getMe: () => fetchApi<{ user: import('../types').User }>('/auth/me'),
};

// Thread API
export const threadApi = {
  list: (label: string, page: number = 1) =>
    fetchApi<{ threads: import('../types').Thread[]; total: number }>(
      `/threads?label=${encodeURIComponent(label)}&page=${page}`
    ),

  get: (threadId: string) =>
    fetchApi<{ thread: import('../types').ThreadDetail }>(`/threads/${threadId}`),

  updateState: (
    threadId: string,
    changes: {
      isRead?: boolean;
      isStarred?: boolean;
      isArchived?: boolean;
      isTrashed?: boolean;
      isSpam?: boolean;
    }
  ) =>
    fetchApi(`/threads/${threadId}/state`, {
      method: 'PATCH',
      body: JSON.stringify(changes),
    }),

  getUnreadCounts: () =>
    fetchApi<{ counts: Record<string, number> }>('/threads/unread-counts'),
};

// Message API
export const messageApi = {
  send: (data: {
    to: string[];
    cc?: string[];
    bcc?: string[];
    subject: string;
    bodyText: string;
    bodyHtml?: string;
    threadId?: string;
    inReplyTo?: string;
  }) =>
    fetchApi<{ threadId: string; messageId: string }>('/messages/send', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  reply: (data: {
    threadId: string;
    inReplyTo?: string;
    to: string[];
    cc?: string[];
    bcc?: string[];
    bodyText: string;
    bodyHtml?: string;
  }) =>
    fetchApi<{ threadId: string; messageId: string }>('/messages/reply', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
};

// Label API
export const labelApi = {
  list: () => fetchApi<{ labels: import('../types').Label[] }>('/labels'),

  create: (name: string, color?: string) =>
    fetchApi<{ label: import('../types').Label }>('/labels', {
      method: 'POST',
      body: JSON.stringify({ name, color }),
    }),

  update: (labelId: string, name?: string, color?: string) =>
    fetchApi<{ label: import('../types').Label }>(`/labels/${labelId}`, {
      method: 'PUT',
      body: JSON.stringify({ name, color }),
    }),

  delete: (labelId: string) =>
    fetchApi(`/labels/${labelId}`, { method: 'DELETE' }),

  assign: (labelId: string, threadId: string) =>
    fetchApi(`/labels/${labelId}/assign`, {
      method: 'POST',
      body: JSON.stringify({ threadId }),
    }),

  remove: (labelId: string, threadId: string) =>
    fetchApi(`/labels/${labelId}/remove`, {
      method: 'POST',
      body: JSON.stringify({ threadId }),
    }),
};

// Draft API
export const draftApi = {
  list: () => fetchApi<{ drafts: import('../types').Draft[] }>('/drafts'),

  get: (draftId: string) =>
    fetchApi<{ draft: import('../types').Draft }>(`/drafts/${draftId}`),

  create: (data: {
    subject?: string;
    bodyText?: string;
    to?: string[];
    cc?: string[];
    bcc?: string[];
    threadId?: string;
    inReplyTo?: string;
  }) =>
    fetchApi<{ draft: import('../types').Draft }>('/drafts', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  update: (
    draftId: string,
    data: {
      subject?: string;
      bodyText?: string;
      to?: string[];
      cc?: string[];
      bcc?: string[];
      version: number;
    }
  ) =>
    fetchApi<{ draft: import('../types').Draft }>(`/drafts/${draftId}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),

  delete: (draftId: string) =>
    fetchApi(`/drafts/${draftId}`, { method: 'DELETE' }),
};

// Search API
export const searchApi = {
  search: (q: string, page: number = 1) =>
    fetchApi<{
      results: import('../types').SearchResult[];
      total: number;
      page: number;
      /** True when Elasticsearch was down and results came from a SQL fallback. */
      degraded?: boolean;
    }>(`/search?q=${encodeURIComponent(q)}&page=${page}`),
};

// Contact API
export const contactApi = {
  search: (q: string) =>
    fetchApi<{ contacts: import('../types').Contact[] }>(
      `/contacts?q=${encodeURIComponent(q)}`
    ),
};
