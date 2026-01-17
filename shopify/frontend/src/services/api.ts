const API_BASE = '/api';

async function request<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const response = await fetch(`${API_BASE}${endpoint}`, {
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
    request<{ user: import('../types').User }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),

  register: (email: string, password: string, name: string) =>
    request<{ user: import('../types').User }>('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password, name }),
    }),

  logout: () => request('/auth/logout', { method: 'POST' }),

  me: () => request<{ user: import('../types').User }>('/auth/me'),
};

// Stores
export const storesApi = {
  list: () => request<{ stores: import('../types').Store[] }>('/stores'),

  get: (storeId: number) =>
    request<{ store: import('../types').Store }>(`/stores/${storeId}`),

  create: (data: { name: string; subdomain: string; description?: string }) =>
    request<{ store: import('../types').Store }>('/stores', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  update: (storeId: number, data: Partial<import('../types').Store>) =>
    request<{ store: import('../types').Store }>(`/stores/${storeId}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),

  analytics: (storeId: number) =>
    request<{ analytics: import('../types').Analytics }>(`/stores/${storeId}/analytics`),
};

// Products
export const productsApi = {
  list: (storeId: number) =>
    request<{ products: import('../types').Product[] }>(`/stores/${storeId}/products`),

  get: (storeId: number, productId: number) =>
    request<{ product: import('../types').Product }>(`/stores/${storeId}/products/${productId}`),

  create: (storeId: number, data: Partial<import('../types').Product>) =>
    request<{ product: import('../types').Product }>(`/stores/${storeId}/products`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  update: (storeId: number, productId: number, data: Partial<import('../types').Product>) =>
    request<{ product: import('../types').Product }>(`/stores/${storeId}/products/${productId}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),

  delete: (storeId: number, productId: number) =>
    request(`/stores/${storeId}/products/${productId}`, { method: 'DELETE' }),
};

// Variants
export const variantsApi = {
  create: (storeId: number, productId: number, data: Partial<import('../types').Variant>) =>
    request<{ variant: import('../types').Variant }>(`/stores/${storeId}/products/${productId}/variants`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  update: (storeId: number, variantId: number, data: Partial<import('../types').Variant>) =>
    request<{ variant: import('../types').Variant }>(`/stores/${storeId}/variants/${variantId}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),

  delete: (storeId: number, variantId: number) =>
    request(`/stores/${storeId}/variants/${variantId}`, { method: 'DELETE' }),
};

// Collections
export const collectionsApi = {
  list: (storeId: number) =>
    request<{ collections: import('../types').Collection[] }>(`/stores/${storeId}/collections`),

  get: (storeId: number, collectionId: number) =>
    request<{ collection: import('../types').Collection }>(`/stores/${storeId}/collections/${collectionId}`),

  create: (storeId: number, data: Partial<import('../types').Collection>) =>
    request<{ collection: import('../types').Collection }>(`/stores/${storeId}/collections`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  update: (storeId: number, collectionId: number, data: Partial<import('../types').Collection>) =>
    request<{ collection: import('../types').Collection }>(`/stores/${storeId}/collections/${collectionId}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),

  delete: (storeId: number, collectionId: number) =>
    request(`/stores/${storeId}/collections/${collectionId}`, { method: 'DELETE' }),
};

// Orders
export const ordersApi = {
  list: (storeId: number) =>
    request<{ orders: import('../types').Order[] }>(`/stores/${storeId}/orders`),

  get: (storeId: number, orderId: number) =>
    request<{ order: import('../types').Order }>(`/stores/${storeId}/orders/${orderId}`),

  update: (storeId: number, orderId: number, data: Partial<import('../types').Order>) =>
    request<{ order: import('../types').Order }>(`/stores/${storeId}/orders/${orderId}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
};

// Customers
export const customersApi = {
  list: (storeId: number) =>
    request<{ customers: import('../types').Customer[] }>(`/stores/${storeId}/customers`),

  get: (storeId: number, customerId: number) =>
    request<{ customer: import('../types').Customer }>(`/stores/${storeId}/customers/${customerId}`),
};

// Storefront API
export const storefrontApi = {
  getStore: (subdomain: string) =>
    request<{ store: import('../types').Store }>(`/storefront/${subdomain}`),

  getProducts: (subdomain: string) =>
    request<{ products: import('../types').Product[] }>(`/storefront/${subdomain}/products`),

  getProduct: (subdomain: string, handle: string) =>
    request<{ product: import('../types').Product }>(`/storefront/${subdomain}/products/${handle}`),

  getCollections: (subdomain: string) =>
    request<{ collections: import('../types').Collection[] }>(`/storefront/${subdomain}/collections`),

  getCollection: (subdomain: string, handle: string) =>
    request<{ collection: import('../types').Collection }>(`/storefront/${subdomain}/collections/${handle}`),

  getCart: (subdomain: string) =>
    request<{ cart: import('../types').Cart | null }>(`/storefront/${subdomain}/cart`),

  addToCart: (subdomain: string, variantId: number, quantity: number) =>
    request<{ cart: import('../types').Cart; sessionId: string }>(`/storefront/${subdomain}/cart/add`, {
      method: 'POST',
      body: JSON.stringify({ variantId, quantity }),
    }),

  updateCart: (subdomain: string, variantId: number, quantity: number) =>
    request<{ cart: import('../types').Cart }>(`/storefront/${subdomain}/cart/update`, {
      method: 'PUT',
      body: JSON.stringify({ variantId, quantity }),
    }),

  checkout: (subdomain: string, data: { email: string; shippingAddress: import('../types').Address }) =>
    request<{ order: import('../types').Order }>(`/storefront/${subdomain}/checkout`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
};
