import type {
  Transaction,
  Refund,
  Chargeback,
  Merchant,
  DashboardStats,
  VolumeDataPoint,
  CreatePaymentRequest,
  ApiResponse,
} from '../types';

const API_BASE = '/api/v1';

function getAuthHeaders(): HeadersInit {
  const apiKey = localStorage.getItem('payment-auth');
  if (apiKey) {
    try {
      const parsed = JSON.parse(apiKey);
      if (parsed.state?.apiKey) {
        return {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${parsed.state.apiKey}`,
        };
      }
    } catch {
      // Ignore parse errors
    }
  }
  return { 'Content-Type': 'application/json' };
}

async function fetchApi<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const response = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    headers: {
      ...getAuthHeaders(),
      ...options.headers,
    },
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || 'API request failed');
  }

  return data;
}

// Merchant API
export async function createMerchant(
  name: string,
  email: string,
  defaultCurrency = 'USD'
): Promise<Merchant & { api_key: string; webhook_secret: string }> {
  return fetchApi('/merchants', {
    method: 'POST',
    body: JSON.stringify({ name, email, default_currency: defaultCurrency }),
  });
}

export async function getMerchantProfile(): Promise<Merchant> {
  return fetchApi('/merchants/me');
}

export async function getDashboardStats(
  startDate?: Date,
  endDate?: Date
): Promise<DashboardStats> {
  const params = new URLSearchParams();
  if (startDate) params.set('start_date', startDate.toISOString());
  if (endDate) params.set('end_date', endDate.toISOString());
  return fetchApi(`/merchants/me/stats?${params}`);
}

export async function getVolumeData(
  startDate?: Date,
  endDate?: Date,
  granularity: 'hour' | 'day' | 'week' = 'day'
): Promise<{ data: VolumeDataPoint[] }> {
  const params = new URLSearchParams();
  if (startDate) params.set('start_date', startDate.toISOString());
  if (endDate) params.set('end_date', endDate.toISOString());
  params.set('granularity', granularity);
  return fetchApi(`/merchants/me/volume?${params}`);
}

// Payments API
export async function createPayment(
  request: CreatePaymentRequest
): Promise<Transaction> {
  const idempotencyKey = `pay_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  return fetchApi('/payments', {
    method: 'POST',
    headers: {
      'Idempotency-Key': idempotencyKey,
    },
    body: JSON.stringify(request),
  });
}

export async function getPayment(id: string): Promise<Transaction> {
  return fetchApi(`/payments/${id}`);
}

export async function listPayments(
  limit = 50,
  offset = 0,
  status?: string
): Promise<ApiResponse<Transaction[]>> {
  const params = new URLSearchParams();
  params.set('limit', limit.toString());
  params.set('offset', offset.toString());
  if (status) params.set('status', status);
  return fetchApi(`/payments?${params}`);
}

export async function capturePayment(id: string): Promise<Transaction> {
  return fetchApi(`/payments/${id}/capture`, { method: 'POST' });
}

export async function voidPayment(id: string): Promise<Transaction> {
  return fetchApi(`/payments/${id}/void`, { method: 'POST' });
}

export async function refundPayment(
  id: string,
  amount?: number,
  reason?: string
): Promise<Refund> {
  const idempotencyKey = `ref_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  return fetchApi(`/payments/${id}/refund`, {
    method: 'POST',
    headers: {
      'Idempotency-Key': idempotencyKey,
    },
    body: JSON.stringify({ amount, reason }),
  });
}

// Refunds API
export async function listRefunds(
  limit = 50,
  offset = 0
): Promise<ApiResponse<Refund[]>> {
  const params = new URLSearchParams();
  params.set('limit', limit.toString());
  params.set('offset', offset.toString());
  return fetchApi(`/refunds?${params}`);
}

// Chargebacks API
export async function listChargebacks(
  limit = 50,
  offset = 0,
  status?: string
): Promise<ApiResponse<Chargeback[]>> {
  const params = new URLSearchParams();
  params.set('limit', limit.toString());
  params.set('offset', offset.toString());
  if (status) params.set('status', status);
  return fetchApi(`/chargebacks?${params}`);
}

// Ledger API
export async function verifyLedger(
  startDate?: Date,
  endDate?: Date
): Promise<{
  balanced: boolean;
  total_debits: number;
  total_credits: number;
  period: { start: string; end: string };
}> {
  const params = new URLSearchParams();
  if (startDate) params.set('start_date', startDate.toISOString());
  if (endDate) params.set('end_date', endDate.toISOString());
  return fetchApi(`/ledger/verify?${params}`);
}

export async function getLedgerSummary(
  startDate?: Date,
  endDate?: Date
): Promise<{
  by_account: Array<{
    account_id: string;
    account_name: string;
    net_change: number;
  }>;
  total_volume: number;
  period: { start: string; end: string };
}> {
  const params = new URLSearchParams();
  if (startDate) params.set('start_date', startDate.toISOString());
  if (endDate) params.set('end_date', endDate.toISOString());
  return fetchApi(`/ledger/summary?${params}`);
}
