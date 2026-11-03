import type {
  User,
  Wallet,
  Transaction,
  TransferRequest,
  PaymentMethod,
  ReconciliationReport,
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

// Auth
/** Auth API client for login, register, logout, and session check. */
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

// Wallet
/** Wallet API client for balance queries, deposits, and withdrawals. */
export const walletApi = {
  get: () =>
    request<{ wallet: Wallet }>('/wallet'),

  deposit: (amountCents: number, paymentMethodId: string, idempotencyKey: string) =>
    request<{ transaction: Transaction; wallet: Wallet }>('/wallet/deposit', {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify({ amountCents, paymentMethodId }),
    }),

  withdraw: (amountCents: number, paymentMethodId: string, idempotencyKey: string) =>
    request<{ transaction: Transaction; wallet: Wallet }>('/wallet/withdraw', {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify({ amountCents, paymentMethodId }),
    }),
};

// Transfers
/** Transfers API client for P2P sends and transaction history. */
export const transfersApi = {
  send: (recipientId: string, amountCents: number, note: string | undefined, idempotencyKey: string) =>
    request<{ transaction: Transaction; senderBalance: number }>('/transfers', {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify({ recipientId, amountCents, note }),
    }),

  list: (type?: string) => {
    const params = type ? `?type=${type}` : '';
    return request<{ transactions: Transaction[] }>(`/transfers${params}`);
  },
};

// Requests
/** Requests API client for creating, listing, paying, and declining money requests. */
export const requestsApi = {
  create: (payerId: string, amountCents: number, note?: string) =>
    request<{ request: TransferRequest }>('/requests', {
      method: 'POST',
      body: JSON.stringify({ payerId, amountCents, note }),
    }),

  list: (direction?: string, status?: string) => {
    const params = new URLSearchParams();
    if (direction) params.set('direction', direction);
    if (status) params.set('status', status);
    const qs = params.toString();
    return request<{ requests: TransferRequest[] }>(`/requests${qs ? `?${qs}` : ''}`);
  },

  pay: (id: string) =>
    request<{ request: { id: string; status: string }; transaction: Transaction }>(
      `/requests/${id}/pay`,
      { method: 'POST' },
    ),

  decline: (id: string) =>
    request<{ request: { id: string; status: string } }>(
      `/requests/${id}/decline`,
      { method: 'POST' },
    ),

  cancel: (id: string) =>
    request<{ request: { id: string; status: string } }>(
      `/requests/${id}/cancel`,
      { method: 'POST' },
    ),
};

// Payment Methods
/** Payment methods API client for listing, adding, removing, and setting defaults. */
export const paymentMethodsApi = {
  list: () =>
    request<{ paymentMethods: PaymentMethod[] }>('/payment-methods'),

  add: (type: string, label: string, lastFour?: string, isDefault?: boolean) =>
    request<{ paymentMethod: PaymentMethod }>('/payment-methods', {
      method: 'POST',
      body: JSON.stringify({ type, label, lastFour, isDefault }),
    }),

  remove: (id: string) =>
    request<{ message: string }>(`/payment-methods/${id}`, { method: 'DELETE' }),

  setDefault: (id: string) =>
    request<{ message: string }>(`/payment-methods/${id}/default`, { method: 'PUT' }),
};

// Users
/** Users API client for searching users by name, username, or email. */
export const usersApi = {
  search: (q: string) =>
    request<{ users: User[] }>(`/users/search?q=${encodeURIComponent(q)}`),
};

// Admin
/** Admin API client: ledger reconciliation report. */
export const adminApi = {
  reconciliation: () => request<ReconciliationReport>('/admin/reconciliation'),
};
