const API_BASE = '/api/v1';

async function fetchWithAuth(url: string, options: RequestInit = {}) {
  const response = await fetch(`${API_BASE}${url}`, {
    ...options,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(error.error || 'Request failed');
  }

  return response.json();
}

// Auth
export const authApi = {
  login: (email: string, password: string) =>
    fetchWithAuth('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),

  register: (email: string, name: string, password: string) =>
    fetchWithAuth('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, name, password }),
    }),

  logout: () =>
    fetchWithAuth('/auth/logout', { method: 'POST' }),

  me: () => fetchWithAuth('/auth/me'),
};

// Envelopes
export const envelopeApi = {
  list: (status?: string, page = 1, limit = 20) => {
    const params = new URLSearchParams({ page: String(page), limit: String(limit) });
    if (status) params.set('status', status);
    return fetchWithAuth(`/envelopes?${params}`);
  },

  get: (id: string) => fetchWithAuth(`/envelopes/${id}`),

  create: (data: { name: string; message?: string; authenticationLevel?: string }) =>
    fetchWithAuth('/envelopes', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  update: (id: string, data: Partial<{ name: string; message: string }>) =>
    fetchWithAuth(`/envelopes/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),

  send: (id: string) =>
    fetchWithAuth(`/envelopes/${id}/send`, { method: 'POST' }),

  void: (id: string, reason: string) =>
    fetchWithAuth(`/envelopes/${id}/void`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),

  delete: (id: string) =>
    fetchWithAuth(`/envelopes/${id}`, { method: 'DELETE' }),

  stats: () => fetchWithAuth('/envelopes/stats/summary'),
};

// Documents
export const documentApi = {
  upload: async (envelopeId: string, file: File) => {
    const formData = new FormData();
    formData.append('document', file);

    const response = await fetch(`${API_BASE}/documents/upload/${envelopeId}`, {
      method: 'POST',
      credentials: 'include',
      body: formData,
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Upload failed' }));
      throw new Error(error.error || 'Upload failed');
    }

    return response.json();
  },

  get: (id: string) => fetchWithAuth(`/documents/${id}`),

  getForEnvelope: (envelopeId: string) =>
    fetchWithAuth(`/documents/envelope/${envelopeId}`),

  view: (id: string) => `${API_BASE}/documents/${id}/view`,

  download: (id: string) => `${API_BASE}/documents/${id}/download`,

  delete: (id: string) =>
    fetchWithAuth(`/documents/${id}`, { method: 'DELETE' }),
};

// Recipients
export const recipientApi = {
  add: (envelopeId: string, data: { name: string; email: string; role?: string; routingOrder?: number }) =>
    fetchWithAuth(`/recipients/${envelopeId}`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  getForEnvelope: (envelopeId: string) =>
    fetchWithAuth(`/recipients/envelope/${envelopeId}`),

  update: (id: string, data: Partial<{ name: string; email: string; routingOrder: number }>) =>
    fetchWithAuth(`/recipients/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),

  delete: (id: string) =>
    fetchWithAuth(`/recipients/${id}`, { method: 'DELETE' }),

  reorder: (envelopeId: string, recipients: { id: string; routingOrder: number }[]) =>
    fetchWithAuth(`/recipients/envelope/${envelopeId}/reorder`, {
      method: 'POST',
      body: JSON.stringify({ recipients }),
    }),
};

// Fields
export const fieldApi = {
  add: (documentId: string, data: {
    recipientId: string;
    type: string;
    pageNumber: number;
    x: number;
    y: number;
    width?: number;
    height?: number;
  }) =>
    fetchWithAuth(`/fields/${documentId}`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  getForDocument: (documentId: string) =>
    fetchWithAuth(`/fields/document/${documentId}`),

  update: (id: string, data: Partial<{ x: number; y: number; width: number; height: number }>) =>
    fetchWithAuth(`/fields/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),

  delete: (id: string) =>
    fetchWithAuth(`/fields/${id}`, { method: 'DELETE' }),
};

// Signing
export const signingApi = {
  getSession: (accessToken: string) =>
    fetch(`${API_BASE}/signing/session/${accessToken}`, {
      credentials: 'include',
    }).then(r => {
      if (!r.ok) throw new Error('Invalid signing link');
      return r.json();
    }),

  getDocument: (accessToken: string, documentId: string) =>
    `${API_BASE}/signing/document/${accessToken}/${documentId}`,

  sign: (accessToken: string, fieldId: string, signatureData: string, type = 'draw') =>
    fetch(`${API_BASE}/signing/sign/${accessToken}`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fieldId, signatureData, type }),
    }).then(r => {
      if (!r.ok) return r.json().then(e => { throw new Error(e.error); });
      return r.json();
    }),

  completeField: (accessToken: string, fieldId: string, value?: string) =>
    fetch(`${API_BASE}/signing/complete-field/${accessToken}`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fieldId, value }),
    }).then(r => {
      if (!r.ok) return r.json().then(e => { throw new Error(e.error); });
      return r.json();
    }),

  finish: (accessToken: string) =>
    fetch(`${API_BASE}/signing/finish/${accessToken}`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
    }).then(r => {
      if (!r.ok) return r.json().then(e => { throw new Error(e.error); });
      return r.json();
    }),

  decline: (accessToken: string, reason?: string) =>
    fetch(`${API_BASE}/signing/decline/${accessToken}`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason }),
    }).then(r => {
      if (!r.ok) return r.json().then(e => { throw new Error(e.error); });
      return r.json();
    }),
};

// Audit
export const auditApi = {
  getEvents: (envelopeId: string) =>
    fetchWithAuth(`/audit/envelope/${envelopeId}`),

  verify: (envelopeId: string) =>
    fetchWithAuth(`/audit/verify/${envelopeId}`),

  getCertificate: (envelopeId: string) =>
    fetchWithAuth(`/audit/certificate/${envelopeId}`),

  publicVerify: (envelopeId?: string, hash?: string) => {
    const params = new URLSearchParams();
    if (envelopeId) params.set('envelopeId', envelopeId);
    if (hash) params.set('hash', hash);
    return fetch(`${API_BASE}/audit/public/verify?${params}`).then(r => r.json());
  },
};

// Admin
export const adminApi = {
  stats: () => fetchWithAuth('/admin/stats'),

  listUsers: (page = 1, limit = 20) =>
    fetchWithAuth(`/admin/users?page=${page}&limit=${limit}`),

  listEnvelopes: (status?: string, page = 1, limit = 20) => {
    const params = new URLSearchParams({ page: String(page), limit: String(limit) });
    if (status) params.set('status', status);
    return fetchWithAuth(`/admin/envelopes?${params}`);
  },

  getEnvelope: (id: string) =>
    fetchWithAuth(`/admin/envelopes/${id}`),

  getEmails: (limit = 50) =>
    fetchWithAuth(`/admin/emails?limit=${limit}`),

  updateUserRole: (id: string, role: 'user' | 'admin') =>
    fetchWithAuth(`/admin/users/${id}/role`, {
      method: 'PUT',
      body: JSON.stringify({ role }),
    }),
};
