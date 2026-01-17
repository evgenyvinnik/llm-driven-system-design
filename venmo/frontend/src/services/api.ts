const API_BASE = '/api';

function getSessionId(): string | null {
  return localStorage.getItem('sessionId');
}

async function request<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const sessionId = getSessionId();

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>),
  };

  if (sessionId) {
    headers['x-session-id'] = sessionId;
  }

  const response = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    headers,
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(error.error || 'Request failed');
  }

  return response.json();
}

export const api = {
  // Auth
  login: (username: string, password: string) =>
    request<{ user: import('../types').User; sessionId: string }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),

  register: (data: { username: string; email: string; password: string; name: string }) =>
    request<{ user: import('../types').User; sessionId: string }>('/auth/register', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  logout: () =>
    request('/auth/logout', { method: 'POST' }),

  getMe: () =>
    request<import('../types').User & { wallet: { balance: number; pendingBalance: number } }>('/auth/me'),

  searchUsers: (q: string) =>
    request<Array<{ id: string; username: string; name: string; avatar_url: string }>>(`/auth/search?q=${encodeURIComponent(q)}`),

  getUserProfile: (username: string) =>
    request<{ id: string; username: string; name: string; avatar_url: string; friends_count: number; transactions_count: number; is_friend: boolean }>(`/auth/${username}`),

  // Wallet
  getWallet: () =>
    request<{ balance: number; pendingBalance: number; paymentMethods: import('../types').PaymentMethod[] }>('/wallet'),

  getTransactionHistory: (limit?: number, offset?: number) =>
    request<import('../types').Transfer[]>(`/wallet/history?limit=${limit || 50}&offset=${offset || 0}`),

  deposit: (amount: number) =>
    request<{ message: string; newBalance: number }>('/wallet/deposit', {
      method: 'POST',
      body: JSON.stringify({ amount }),
    }),

  // Transfers
  sendMoney: (data: { recipientUsername: string; amount: number; note: string; visibility?: string }) =>
    request<import('../types').Transfer>('/transfers/send', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  getTransfer: (id: string) =>
    request<import('../types').Transfer & { comments: Array<{ id: string; content: string; username: string; name: string; avatar_url: string; created_at: string }> }>(`/transfers/${id}`),

  likeTransfer: (id: string) =>
    request<{ likes_count: number; user_liked: boolean }>(`/transfers/${id}/like`, { method: 'POST' }),

  unlikeTransfer: (id: string) =>
    request<{ likes_count: number; user_liked: boolean }>(`/transfers/${id}/like`, { method: 'DELETE' }),

  addComment: (id: string, content: string) =>
    request<{ id: string; content: string; username: string; created_at: string }>(`/transfers/${id}/comments`, {
      method: 'POST',
      body: JSON.stringify({ content }),
    }),

  // Payment Requests
  createRequest: (data: { recipientUsername: string; amount: number; note: string }) =>
    request<import('../types').PaymentRequest>('/requests', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  getSentRequests: (status?: string) =>
    request<import('../types').PaymentRequest[]>(`/requests/sent${status ? `?status=${status}` : ''}`),

  getReceivedRequests: (status?: string) =>
    request<import('../types').PaymentRequest[]>(`/requests/received${status ? `?status=${status}` : ''}`),

  payRequest: (id: string) =>
    request<{ message: string; transfer_id: string }>(`/requests/${id}/pay`, { method: 'POST' }),

  declineRequest: (id: string) =>
    request<{ message: string }>(`/requests/${id}/decline`, { method: 'POST' }),

  cancelRequest: (id: string) =>
    request<{ message: string }>(`/requests/${id}/cancel`, { method: 'POST' }),

  remindRequest: (id: string) =>
    request<{ message: string }>(`/requests/${id}/remind`, { method: 'POST' }),

  // Feed
  getFeed: (limit?: number, before?: string) =>
    request<import('../types').Transfer[]>(`/feed?limit=${limit || 20}${before ? `&before=${before}` : ''}`),

  getGlobalFeed: (limit?: number, before?: string) =>
    request<import('../types').Transfer[]>(`/feed/global?limit=${limit || 20}${before ? `&before=${before}` : ''}`),

  getUserFeed: (username: string, limit?: number, before?: string) =>
    request<import('../types').Transfer[]>(`/feed/user/${username}?limit=${limit || 20}${before ? `&before=${before}` : ''}`),

  // Friends
  getFriends: () =>
    request<import('../types').Friend[]>('/friends'),

  getFriendRequests: () =>
    request<import('../types').Friend[]>('/friends/requests'),

  getSentFriendRequests: () =>
    request<import('../types').Friend[]>('/friends/sent'),

  sendFriendRequest: (username: string) =>
    request<{ message: string }>(`/friends/request/${username}`, { method: 'POST' }),

  acceptFriendRequest: (username: string) =>
    request<{ message: string }>(`/friends/accept/${username}`, { method: 'POST' }),

  declineFriendRequest: (username: string) =>
    request<{ message: string }>(`/friends/decline/${username}`, { method: 'POST' }),

  removeFriend: (username: string) =>
    request<{ message: string }>(`/friends/${username}`, { method: 'DELETE' }),

  // Payment Methods
  getPaymentMethods: () =>
    request<import('../types').PaymentMethod[]>('/payment-methods'),

  addBankAccount: (data: { bankName: string; accountType: string; routingNumber: string; accountNumber: string; nickname?: string }) =>
    request<import('../types').PaymentMethod>('/payment-methods/bank', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  addCard: (data: { cardNumber: string; expiryMonth: string; expiryYear: string; cvv: string; nickname?: string; type?: string }) =>
    request<import('../types').PaymentMethod>('/payment-methods/card', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  setDefaultPaymentMethod: (id: string) =>
    request<{ message: string }>(`/payment-methods/${id}/default`, { method: 'POST' }),

  deletePaymentMethod: (id: string) =>
    request<{ message: string }>(`/payment-methods/${id}`, { method: 'DELETE' }),

  cashout: (data: { amount: number; speed: 'instant' | 'standard'; paymentMethodId?: string }) =>
    request<{ message: string; cashout: import('../types').Cashout; newBalance: number; fee: number }>('/payment-methods/cashout', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  getCashouts: () =>
    request<import('../types').Cashout[]>('/payment-methods/cashouts'),
};
