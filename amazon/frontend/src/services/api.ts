const API_BASE = '/api';

async function request<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const sessionId = localStorage.getItem('sessionId');

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>),
  };

  if (sessionId) {
    headers['X-Session-Id'] = sessionId;
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
  login: (email: string, password: string) =>
    request<{ user: import('../types').User; sessionId: string }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),

  register: (email: string, password: string, name: string) =>
    request<{ user: import('../types').User; sessionId: string }>('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password, name }),
    }),

  logout: () => request('/auth/logout', { method: 'POST' }),

  getMe: () => request<{ user: import('../types').User }>('/auth/me'),

  // Products
  getProducts: (params?: Record<string, string | number>) => {
    const query = params ? '?' + new URLSearchParams(params as Record<string, string>).toString() : '';
    return request<{ products: import('../types').Product[]; total: number }>(`/products${query}`);
  },

  getProduct: (id: string) =>
    request<{ product: import('../types').Product }>(`/products/${id}`),

  getProductRecommendations: (id: string) =>
    request<{ recommendations: import('../types').Product[] }>(`/products/${id}/recommendations`),

  // Categories
  getCategories: () =>
    request<{ categories: import('../types').Category[]; flat: import('../types').Category[] }>('/categories'),

  getCategory: (slug: string) =>
    request<{
      category: import('../types').Category;
      subcategories: import('../types').Category[];
      breadcrumbs: { name: string; slug: string }[];
    }>(`/categories/${slug}`),

  // Search
  search: (params: import('../types').SearchFilters) => {
    const query = '?' + new URLSearchParams(params as Record<string, string>).toString();
    return request<{
      products: import('../types').Product[];
      total: number;
      aggregations: import('../types').Aggregations;
    }>(`/search${query}`);
  },

  getSuggestions: (q: string) =>
    request<{ suggestions: string[] }>(`/search/suggestions?q=${encodeURIComponent(q)}`),

  // Cart
  getCart: () => request<import('../types').Cart>('/cart'),

  addToCart: (productId: number, quantity = 1) =>
    request<import('../types').Cart>('/cart', {
      method: 'POST',
      body: JSON.stringify({ productId, quantity }),
    }),

  updateCartItem: (productId: number, quantity: number) =>
    request<import('../types').Cart>(`/cart/${productId}`, {
      method: 'PUT',
      body: JSON.stringify({ quantity }),
    }),

  removeFromCart: (productId: number) =>
    request<import('../types').Cart>(`/cart/${productId}`, {
      method: 'DELETE',
    }),

  clearCart: () => request<import('../types').Cart>('/cart', { method: 'DELETE' }),

  // Orders
  getOrders: (params?: { status?: string; page?: number }) => {
    const query = params ? '?' + new URLSearchParams(params as Record<string, string>).toString() : '';
    return request<{ orders: import('../types').Order[]; total: number }>(`/orders${query}`);
  },

  getOrder: (id: number) =>
    request<{ order: import('../types').Order }>(`/orders/${id}`),

  createOrder: (data: {
    shippingAddress: import('../types').Order['shipping_address'];
    paymentMethod?: string;
  }) =>
    request<{ order: import('../types').Order }>('/orders', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  cancelOrder: (id: number) =>
    request<{ order: import('../types').Order }>(`/orders/${id}/cancel`, {
      method: 'POST',
    }),

  // Reviews
  getProductReviews: (productId: number, params?: { page?: number; sort?: string }) => {
    const query = params ? '?' + new URLSearchParams(params as Record<string, string>).toString() : '';
    return request<{
      reviews: import('../types').Review[];
      summary: import('../types').ReviewSummary;
    }>(`/reviews/product/${productId}${query}`);
  },

  createReview: (data: { productId: number; rating: number; title?: string; content?: string }) =>
    request<{ review: import('../types').Review }>('/reviews', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  markReviewHelpful: (id: number) =>
    request<{ review: import('../types').Review }>(`/reviews/${id}/helpful`, {
      method: 'POST',
    }),
};
