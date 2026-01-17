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

/**
 * Base URL for API requests.
 * Uses relative path for same-origin requests; configure for production.
 */
const API_BASE = '/api/v1';

/**
 * Constructs authorization headers from persisted auth state.
 * Reads the API key from localStorage to add Bearer token.
 * @returns Headers object with Content-Type and optional Authorization
 */
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

/**
 * Generic API fetch wrapper with authentication and error handling.
 * Automatically adds auth headers and parses JSON responses.
 * @param endpoint - API endpoint path (without base URL)
 * @param options - Fetch options (method, body, headers, etc.)
 * @returns Parsed JSON response
 * @throws Error with message from API response on failure
 */
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

// ============================================================================
// Merchant API
// ============================================================================

/**
 * Creates a new merchant account and returns API credentials.
 * @param name - Business name for the merchant
 * @param email - Contact email for the account
 * @param defaultCurrency - Default currency for transactions
 * @returns Merchant record with API key (only returned once)
 */
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

/**
 * Retrieves the current merchant's profile including balance.
 * @returns Merchant profile data
 */
export async function getMerchantProfile(): Promise<Merchant> {
  return fetchApi('/merchants/me');
}

/**
 * Retrieves aggregated dashboard statistics for the merchant.
 * @param startDate - Optional start of reporting period
 * @param endDate - Optional end of reporting period
 * @returns Dashboard metrics including volume, fees, and rates
 */
export async function getDashboardStats(
  startDate?: Date,
  endDate?: Date
): Promise<DashboardStats> {
  const params = new URLSearchParams();
  if (startDate) params.set('start_date', startDate.toISOString());
  if (endDate) params.set('end_date', endDate.toISOString());
  return fetchApi(`/merchants/me/stats?${params}`);
}

/**
 * Retrieves time-series transaction volume data for charts.
 * @param startDate - Optional start of reporting period
 * @param endDate - Optional end of reporting period
 * @param granularity - Time bucket size (hour, day, or week)
 * @returns Array of volume data points
 */
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

// ============================================================================
// Payments API
// ============================================================================

/**
 * Creates a new payment transaction.
 * Automatically generates an idempotency key to prevent duplicates.
 * @param request - Payment details including amount and payment method
 * @returns Created transaction record
 */
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

/**
 * Retrieves a specific payment by ID.
 * @param id - UUID of the transaction
 * @returns Transaction record
 */
export async function getPayment(id: string): Promise<Transaction> {
  return fetchApi(`/payments/${id}`);
}

/**
 * Lists payments for the merchant with pagination.
 * @param limit - Maximum number of payments to return
 * @param offset - Number of payments to skip
 * @param status - Optional status filter
 * @returns Paginated list of transactions
 */
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

/**
 * Captures an authorized payment.
 * @param id - UUID of the authorized transaction
 * @returns Updated transaction with captured status
 */
export async function capturePayment(id: string): Promise<Transaction> {
  return fetchApi(`/payments/${id}/capture`, { method: 'POST' });
}

/**
 * Voids an authorized payment before capture.
 * @param id - UUID of the authorized transaction
 * @returns Updated transaction with voided status
 */
export async function voidPayment(id: string): Promise<Transaction> {
  return fetchApi(`/payments/${id}/void`, { method: 'POST' });
}

/**
 * Creates a refund for a captured payment.
 * @param id - UUID of the transaction to refund
 * @param amount - Optional partial refund amount in cents (full refund if omitted)
 * @param reason - Optional reason for the refund
 * @returns Created refund record
 */
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

// ============================================================================
// Refunds API
// ============================================================================

/**
 * Lists all refunds for the merchant with pagination.
 * @param limit - Maximum number of refunds to return
 * @param offset - Number of refunds to skip
 * @returns Paginated list of refunds
 */
export async function listRefunds(
  limit = 50,
  offset = 0
): Promise<ApiResponse<Refund[]>> {
  const params = new URLSearchParams();
  params.set('limit', limit.toString());
  params.set('offset', offset.toString());
  return fetchApi(`/refunds?${params}`);
}

// ============================================================================
// Chargebacks API
// ============================================================================

/**
 * Lists all chargebacks for the merchant with pagination.
 * @param limit - Maximum number of chargebacks to return
 * @param offset - Number of chargebacks to skip
 * @param status - Optional status filter
 * @returns Paginated list of chargebacks
 */
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

// ============================================================================
// Ledger API
// ============================================================================

/**
 * Verifies that ledger debits equal credits for reconciliation.
 * @param startDate - Optional start of verification period
 * @param endDate - Optional end of verification period
 * @returns Verification result with totals
 */
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

/**
 * Retrieves ledger summary showing net changes by account.
 * @param startDate - Optional start of reporting period
 * @param endDate - Optional end of reporting period
 * @returns Summary with account breakdowns and total volume
 */
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
