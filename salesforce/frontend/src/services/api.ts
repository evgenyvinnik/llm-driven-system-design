import type {
  Account, Contact, Opportunity, Lead, Activity,
  DashboardKPIs, PipelineStage, RevenueByMonth, LeadsBySource, ReportScope, User,
} from '../types';

const BASE_URL = '/api';

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE_URL}${url}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
    credentials: 'include',
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(body.error || `HTTP ${res.status}`);
  }

  return res.json();
}

/** Authentication API client for login, registration, logout, and session check. */
export const authApi = {
  login: (username: string, password: string) =>
    request<{ user: User }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),

  register: (username: string, email: string, password: string, displayName?: string) =>
    request<{ user: User }>('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ username, email, password, displayName }),
    }),

  logout: () =>
    request<{ message: string }>('/auth/logout', { method: 'POST' }),

  me: () =>
    request<{ user: User }>('/auth/me'),
};

/** Dashboard API client for fetching KPI aggregations. */
export const dashboardApi = {
  getKPIs: () =>
    request<{ kpis: DashboardKPIs }>('/dashboard'),
};

/** Accounts API client for CRUD operations and related entity lookups. */
export const accountsApi = {
  list: (params?: { search?: string; industry?: string; page?: number; limit?: number }) => {
    const searchParams = new URLSearchParams();
    if (params?.search) searchParams.set('search', params.search);
    if (params?.industry) searchParams.set('industry', params.industry);
    if (params?.page) searchParams.set('page', String(params.page));
    if (params?.limit) searchParams.set('limit', String(params.limit));
    const qs = searchParams.toString();
    return request<{ accounts: Account[]; total: number; page: number; limit: number }>(
      `/accounts${qs ? `?${qs}` : ''}`,
    );
  },

  get: (id: string) =>
    request<{ account: Account }>(`/accounts/${id}`),

  create: (data: Partial<Account>) =>
    request<{ account: Account }>('/accounts', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  update: (id: string, data: Partial<Account>) =>
    request<{ account: Account }>(`/accounts/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),

  delete: (id: string) =>
    request<{ message: string }>(`/accounts/${id}`, { method: 'DELETE' }),

  getContacts: (id: string) =>
    request<{ contacts: Contact[] }>(`/accounts/${id}/contacts`),

  getOpportunities: (id: string) =>
    request<{ opportunities: Opportunity[] }>(`/accounts/${id}/opportunities`),
};

/** Contacts API client for CRUD operations with account association. */
export const contactsApi = {
  list: (params?: { search?: string; accountId?: string; page?: number; limit?: number }) => {
    const searchParams = new URLSearchParams();
    if (params?.search) searchParams.set('search', params.search);
    if (params?.accountId) searchParams.set('accountId', params.accountId);
    if (params?.page) searchParams.set('page', String(params.page));
    if (params?.limit) searchParams.set('limit', String(params.limit));
    const qs = searchParams.toString();
    return request<{ contacts: Contact[]; total: number; page: number; limit: number }>(
      `/contacts${qs ? `?${qs}` : ''}`,
    );
  },

  get: (id: string) =>
    request<{ contact: Contact }>(`/contacts/${id}`),

  create: (data: Record<string, unknown>) =>
    request<{ contact: Contact }>('/contacts', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  update: (id: string, data: Record<string, unknown>) =>
    request<{ contact: Contact }>(`/contacts/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),

  delete: (id: string) =>
    request<{ message: string }>(`/contacts/${id}`, { method: 'DELETE' }),
};

/** Opportunities API client for CRUD operations and kanban stage updates. */
export const opportunitiesApi = {
  list: (params?: { search?: string; stage?: string; accountId?: string; page?: number; limit?: number }) => {
    const searchParams = new URLSearchParams();
    if (params?.search) searchParams.set('search', params.search);
    if (params?.stage) searchParams.set('stage', params.stage);
    if (params?.accountId) searchParams.set('accountId', params.accountId);
    if (params?.page) searchParams.set('page', String(params.page));
    if (params?.limit) searchParams.set('limit', String(params.limit));
    const qs = searchParams.toString();
    return request<{ opportunities: Opportunity[]; total: number; page: number; limit: number }>(
      `/opportunities${qs ? `?${qs}` : ''}`,
    );
  },

  get: (id: string) =>
    request<{ opportunity: Opportunity }>(`/opportunities/${id}`),

  create: (data: Record<string, unknown>) =>
    request<{ opportunity: Opportunity }>('/opportunities', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  update: (id: string, data: Record<string, unknown>) =>
    request<{ opportunity: Opportunity }>(`/opportunities/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),

  updateStage: (id: string, stage: string) =>
    request<{ opportunity: Opportunity }>(`/opportunities/${id}/stage`, {
      method: 'PUT',
      body: JSON.stringify({ stage }),
    }),

  delete: (id: string) =>
    request<{ message: string }>(`/opportunities/${id}`, { method: 'DELETE' }),
};

/** Leads API client for CRUD operations and lead-to-account conversion. */
export const leadsApi = {
  list: (params?: { search?: string; status?: string; source?: string; page?: number; limit?: number }) => {
    const searchParams = new URLSearchParams();
    if (params?.search) searchParams.set('search', params.search);
    if (params?.status) searchParams.set('status', params.status);
    if (params?.source) searchParams.set('source', params.source);
    if (params?.page) searchParams.set('page', String(params.page));
    if (params?.limit) searchParams.set('limit', String(params.limit));
    const qs = searchParams.toString();
    return request<{ leads: Lead[]; total: number; page: number; limit: number }>(
      `/leads${qs ? `?${qs}` : ''}`,
    );
  },

  get: (id: string) =>
    request<{ lead: Lead }>(`/leads/${id}`),

  create: (data: Record<string, unknown>) =>
    request<{ lead: Lead }>('/leads', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  update: (id: string, data: Record<string, unknown>) =>
    request<{ lead: Lead }>(`/leads/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),

  convert: (id: string, data: { accountName?: string; opportunityName?: string; opportunityAmount?: number; closeDate?: string }) =>
    request<{ message: string; accountId: string; contactId: string; opportunityId: string | null }>(
      `/leads/${id}/convert`,
      { method: 'POST', body: JSON.stringify(data) },
    ),

  delete: (id: string) =>
    request<{ message: string }>(`/leads/${id}`, { method: 'DELETE' }),
};

/** Activities API client for polymorphic activity CRUD operations. */
export const activitiesApi = {
  list: (params?: { relatedType?: string; relatedId?: string; completed?: boolean; page?: number; limit?: number }) => {
    const searchParams = new URLSearchParams();
    if (params?.relatedType) searchParams.set('relatedType', params.relatedType);
    if (params?.relatedId) searchParams.set('relatedId', params.relatedId);
    if (params?.completed !== undefined) searchParams.set('completed', String(params.completed));
    if (params?.page) searchParams.set('page', String(params.page));
    if (params?.limit) searchParams.set('limit', String(params.limit));
    const qs = searchParams.toString();
    return request<{ activities: Activity[]; total: number; page: number; limit: number }>(
      `/activities${qs ? `?${qs}` : ''}`,
    );
  },

  get: (id: string) =>
    request<{ activity: Activity }>(`/activities/${id}`),

  create: (data: Record<string, unknown>) =>
    request<{ activity: Activity }>('/activities', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  update: (id: string, data: Record<string, unknown>) =>
    request<{ activity: Activity }>(`/activities/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),

  delete: (id: string) =>
    request<{ message: string }>(`/activities/${id}`, { method: 'DELETE' }),
};

/** Reports API client for pipeline, revenue, and lead-source aggregation data. */
export const reportsApi = {
  pipeline: (all?: boolean) =>
    request<{ pipeline: PipelineStage[]; scope: ReportScope }>(`/reports/pipeline${all ? '?all=true' : ''}`),

  revenue: (months?: number, all?: boolean) => {
    const params = new URLSearchParams();
    if (months) params.set('months', String(months));
    if (all) params.set('all', 'true');
    const qs = params.toString();
    return request<{ revenue: RevenueByMonth[]; scope: ReportScope }>(`/reports/revenue${qs ? `?${qs}` : ''}`);
  },

  leads: (all?: boolean) =>
    request<{ leads: LeadsBySource[]; scope: ReportScope }>(`/reports/leads${all ? '?all=true' : ''}`),
};
