import { useMerchantStore } from '@/stores/merchantStore';
import type {
  PaymentIntent,
  Customer,
  PaymentMethod,
  Charge,
  Refund,
  Balance,
  BalanceSummary,
  BalanceTransaction,
  WebhookEvent,
  WebhookEndpoint,
  Merchant,
  ListResponse,
  ApiError,
} from '@/types';

const API_BASE = '/v1';

async function fetchApi<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const apiKey = useMerchantStore.getState().apiKey;

  const headers: HeadersInit = {
    'Content-Type': 'application/json',
    ...options.headers,
  };

  if (apiKey) {
    (headers as Record<string, string>)['Authorization'] = `Bearer ${apiKey}`;
  }

  const response = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    headers,
  });

  const data = await response.json();

  if (!response.ok) {
    const error = data as ApiError;
    throw new Error(error.error?.message || 'An error occurred');
  }

  return data as T;
}

// Payment Intents
export async function listPaymentIntents(
  params: { limit?: number; offset?: number; status?: string } = {}
): Promise<ListResponse<PaymentIntent>> {
  const query = new URLSearchParams();
  if (params.limit) query.set('limit', params.limit.toString());
  if (params.offset) query.set('offset', params.offset.toString());
  if (params.status) query.set('status', params.status);

  return fetchApi<ListResponse<PaymentIntent>>(
    `/payment_intents?${query.toString()}`
  );
}

export async function getPaymentIntent(id: string): Promise<PaymentIntent> {
  return fetchApi<PaymentIntent>(`/payment_intents/${id}`);
}

export async function createPaymentIntent(data: {
  amount: number;
  currency?: string;
  customer?: string;
  payment_method?: string;
  capture_method?: 'automatic' | 'manual';
  description?: string;
  metadata?: Record<string, string>;
}): Promise<PaymentIntent> {
  return fetchApi<PaymentIntent>('/payment_intents', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function confirmPaymentIntent(
  id: string,
  paymentMethodId: string
): Promise<PaymentIntent> {
  return fetchApi<PaymentIntent>(`/payment_intents/${id}/confirm`, {
    method: 'POST',
    body: JSON.stringify({ payment_method: paymentMethodId }),
  });
}

export async function capturePaymentIntent(
  id: string,
  amountToCapture?: number
): Promise<PaymentIntent> {
  return fetchApi<PaymentIntent>(`/payment_intents/${id}/capture`, {
    method: 'POST',
    body: JSON.stringify({ amount_to_capture: amountToCapture }),
  });
}

export async function cancelPaymentIntent(
  id: string,
  reason?: string
): Promise<PaymentIntent> {
  return fetchApi<PaymentIntent>(`/payment_intents/${id}/cancel`, {
    method: 'POST',
    body: JSON.stringify({ cancellation_reason: reason }),
  });
}

// Customers
export async function listCustomers(
  params: { limit?: number; offset?: number; email?: string } = {}
): Promise<ListResponse<Customer>> {
  const query = new URLSearchParams();
  if (params.limit) query.set('limit', params.limit.toString());
  if (params.offset) query.set('offset', params.offset.toString());
  if (params.email) query.set('email', params.email);

  return fetchApi<ListResponse<Customer>>(`/customers?${query.toString()}`);
}

export async function getCustomer(id: string): Promise<Customer> {
  return fetchApi<Customer>(`/customers/${id}`);
}

export async function createCustomer(data: {
  email?: string;
  name?: string;
  phone?: string;
  metadata?: Record<string, string>;
}): Promise<Customer> {
  return fetchApi<Customer>('/customers', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function updateCustomer(
  id: string,
  data: {
    email?: string;
    name?: string;
    phone?: string;
    metadata?: Record<string, string>;
  }
): Promise<Customer> {
  return fetchApi<Customer>(`/customers/${id}`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function deleteCustomer(id: string): Promise<{ deleted: boolean }> {
  return fetchApi<{ deleted: boolean }>(`/customers/${id}`, {
    method: 'DELETE',
  });
}

// Payment Methods
export async function listPaymentMethods(
  params: { limit?: number; offset?: number; customer?: string } = {}
): Promise<ListResponse<PaymentMethod>> {
  const query = new URLSearchParams();
  if (params.limit) query.set('limit', params.limit.toString());
  if (params.offset) query.set('offset', params.offset.toString());
  if (params.customer) query.set('customer', params.customer);

  return fetchApi<ListResponse<PaymentMethod>>(
    `/payment_methods?${query.toString()}`
  );
}

export async function getPaymentMethod(id: string): Promise<PaymentMethod> {
  return fetchApi<PaymentMethod>(`/payment_methods/${id}`);
}

export async function createPaymentMethod(data: {
  type: 'card';
  card: {
    number: string;
    exp_month: number;
    exp_year: number;
    cvc: string;
  };
  customer?: string;
  billing_details?: Record<string, unknown>;
}): Promise<PaymentMethod> {
  return fetchApi<PaymentMethod>('/payment_methods', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function attachPaymentMethod(
  id: string,
  customerId: string
): Promise<PaymentMethod> {
  return fetchApi<PaymentMethod>(`/payment_methods/${id}/attach`, {
    method: 'POST',
    body: JSON.stringify({ customer: customerId }),
  });
}

export async function detachPaymentMethod(id: string): Promise<PaymentMethod> {
  return fetchApi<PaymentMethod>(`/payment_methods/${id}/detach`, {
    method: 'POST',
  });
}

// Charges
export async function listCharges(
  params: { limit?: number; offset?: number; customer?: string } = {}
): Promise<ListResponse<Charge>> {
  const query = new URLSearchParams();
  if (params.limit) query.set('limit', params.limit.toString());
  if (params.offset) query.set('offset', params.offset.toString());
  if (params.customer) query.set('customer', params.customer);

  return fetchApi<ListResponse<Charge>>(`/charges?${query.toString()}`);
}

export async function getCharge(id: string): Promise<Charge> {
  return fetchApi<Charge>(`/charges/${id}`);
}

// Refunds
export async function listRefunds(
  params: { limit?: number; offset?: number; payment_intent?: string } = {}
): Promise<ListResponse<Refund>> {
  const query = new URLSearchParams();
  if (params.limit) query.set('limit', params.limit.toString());
  if (params.offset) query.set('offset', params.offset.toString());
  if (params.payment_intent) query.set('payment_intent', params.payment_intent);

  return fetchApi<ListResponse<Refund>>(`/refunds?${query.toString()}`);
}

export async function createRefund(data: {
  payment_intent?: string;
  charge?: string;
  amount?: number;
  reason?: string;
  metadata?: Record<string, string>;
}): Promise<Refund> {
  return fetchApi<Refund>('/refunds', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

// Balance
export async function getBalance(): Promise<Balance> {
  return fetchApi<Balance>('/balance');
}

export async function getBalanceSummary(): Promise<BalanceSummary> {
  return fetchApi<BalanceSummary>('/balance/summary');
}

export async function listBalanceTransactions(
  params: { limit?: number; offset?: number } = {}
): Promise<ListResponse<BalanceTransaction>> {
  const query = new URLSearchParams();
  if (params.limit) query.set('limit', params.limit.toString());
  if (params.offset) query.set('offset', params.offset.toString());

  return fetchApi<ListResponse<BalanceTransaction>>(
    `/balance/transactions?${query.toString()}`
  );
}

// Webhooks
export async function listWebhookEvents(
  params: { limit?: number; offset?: number } = {}
): Promise<{ data: WebhookEvent[] }> {
  const query = new URLSearchParams();
  if (params.limit) query.set('limit', params.limit.toString());
  if (params.offset) query.set('offset', params.offset.toString());

  return fetchApi<{ data: WebhookEvent[] }>(
    `/webhooks/events?${query.toString()}`
  );
}

export async function getWebhookEndpoint(): Promise<WebhookEndpoint> {
  return fetchApi<WebhookEndpoint>('/webhooks/endpoints');
}

export async function updateWebhookEndpoint(
  url: string
): Promise<WebhookEndpoint> {
  return fetchApi<WebhookEndpoint>('/webhooks/endpoints', {
    method: 'POST',
    body: JSON.stringify({ url }),
  });
}

export async function deleteWebhookEndpoint(): Promise<{ deleted: boolean }> {
  return fetchApi<{ deleted: boolean }>('/webhooks/endpoints', {
    method: 'DELETE',
  });
}

export async function retryWebhook(eventId: string): Promise<{ queued: boolean }> {
  return fetchApi<{ queued: boolean }>(`/webhooks/events/${eventId}/retry`, {
    method: 'POST',
  });
}

// Merchants
export async function createMerchant(data: {
  name: string;
  email: string;
}): Promise<Merchant> {
  return fetchApi<Merchant>('/merchants', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function getMerchant(): Promise<Merchant> {
  return fetchApi<Merchant>('/merchants/me');
}

export async function listMerchants(
  params: { limit?: number; offset?: number } = {}
): Promise<ListResponse<Merchant>> {
  const query = new URLSearchParams();
  if (params.limit) query.set('limit', params.limit.toString());
  if (params.offset) query.set('offset', params.offset.toString());

  return fetchApi<ListResponse<Merchant>>(`/merchants?${query.toString()}`);
}
