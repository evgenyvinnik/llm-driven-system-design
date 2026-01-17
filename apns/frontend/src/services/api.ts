/**
 * API Service Module.
 *
 * Provides typed HTTP client functions for communicating with the APNs backend.
 * All API calls go through this module for consistent error handling and authentication.
 *
 * @module services/api
 */

/** Base URL for API requests, uses relative path for proxy support */
const API_BASE = '/api/v1';

/**
 * Generic HTTP request function with authentication and error handling.
 * Automatically includes auth token if present and handles JSON parsing.
 *
 * @param endpoint - API endpoint path (will be appended to API_BASE)
 * @param options - Fetch options (method, body, headers, etc.)
 * @returns Parsed JSON response typed as T
 * @throws Error with message from API response or HTTP status
 */
async function request<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const token = localStorage.getItem('auth_token');

  const headers: HeadersInit = {
    'Content-Type': 'application/json',
    ...options.headers,
  };

  if (token) {
    (headers as Record<string, string>)['Authorization'] = `Bearer ${token}`;
  }

  const response = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    headers,
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: 'Request failed' }));
    throw new Error(error.message || `HTTP ${response.status}`);
  }

  if (response.status === 204) {
    return {} as T;
  }

  return response.json();
}

// ============================================================================
// Admin API
// ============================================================================

/**
 * Admin API functions for dashboard operations.
 * Provides authentication and administrative data access.
 */
export const adminApi = {
  /**
   * Authenticate admin user and get session token.
   * @param username - Admin username
   * @param password - Admin password
   * @returns Token and user info
   */
  login: (username: string, password: string) =>
    request<{ token: string; user: { id: string; username: string; role: string } }>(
      '/admin/login',
      { method: 'POST', body: JSON.stringify({ username, password }) }
    ),

  /** End the current admin session. */
  logout: () =>
    request<void>('/admin/logout', { method: 'POST' }),

  /** Get the current authenticated user info. */
  getMe: () =>
    request<{ id: string; username: string; role: string }>('/admin/me'),

  /** Get dashboard statistics including notifications, devices, topics, and recent activity. */
  getStats: () =>
    request<{
      notifications: { total: number; pending: number; queued: number; delivered: number; failed: number; expired: number };
      devices: { total: number; valid: number; invalid: number };
      topics: { topic: string; subscriber_count: number }[];
      recent_notifications: Array<{
        id: string;
        device_id: string;
        status: string;
        created_at: string;
        payload: unknown;
      }>;
    }>('/admin/stats'),

  /**
   * List all registered devices with pagination.
   * @param limit - Maximum number of devices to return
   * @param offset - Number of devices to skip
   */
  getDevices: (limit = 100, offset = 0) =>
    request<{ devices: Array<{
      device_id: string;
      token_hash: string;
      app_bundle_id: string;
      device_info: unknown;
      is_valid: boolean;
      created_at: string;
      last_seen: string;
    }>; total: number }>(`/admin/devices?limit=${limit}&offset=${offset}`),

  /**
   * List notifications with optional filters and pagination.
   * @param limit - Maximum number of notifications to return
   * @param offset - Number of notifications to skip
   * @param status - Filter by status (optional)
   */
  getNotifications: (limit = 100, offset = 0, status?: string) => {
    let url = `/admin/notifications?limit=${limit}&offset=${offset}`;
    if (status) url += `&status=${status}`;
    return request<{ notifications: Array<{
      id: string;
      device_id: string;
      status: string;
      priority: number;
      created_at: string;
      updated_at: string;
      payload: unknown;
    }>; total: number }>(url);
  },

  /**
   * List all feedback entries with pagination.
   * @param limit - Maximum number of entries to return
   * @param offset - Number of entries to skip
   */
  getFeedback: (limit = 100, offset = 0) =>
    request<{ feedback: Array<{
      id: number;
      token_hash: string;
      app_bundle_id: string;
      reason: string;
      timestamp: string;
    }>; total: number }>(`/admin/feedback?limit=${limit}&offset=${offset}`),

  /**
   * Broadcast a notification to all valid devices.
   * @param payload - APNs payload with aps dictionary
   * @param priority - Delivery priority (1, 5, or 10)
   */
  broadcast: (payload: { aps: { alert?: string | { title?: string; body?: string }; badge?: number; sound?: string } }, priority = 10) =>
    request<{ total_devices: number; sent: number; failed: number }>(
      '/admin/broadcast',
      { method: 'POST', body: JSON.stringify({ payload, priority }) }
    ),

  /** Trigger cleanup of expired notifications. */
  cleanup: () =>
    request<{ cleaned: number }>('/admin/cleanup', { method: 'POST' }),
};

// ============================================================================
// Devices API
// ============================================================================

/**
 * Devices API functions for token registration and management.
 * Used by the admin dashboard to view and manage registered devices.
 */
export const devicesApi = {
  /**
   * Register a new device token.
   * @param token - 64-character hex device token
   * @param app_bundle_id - iOS app bundle identifier
   * @param device_info - Optional device metadata
   */
  register: (token: string, app_bundle_id: string, device_info?: unknown) =>
    request<{ device_id: string; is_new: boolean }>(
      '/devices/register',
      { method: 'POST', body: JSON.stringify({ token, app_bundle_id, device_info }) }
    ),

  /**
   * Look up a device by its raw token.
   * @param token - 64-character hex device token
   */
  getByToken: (token: string) =>
    request<{
      device_id: string;
      token_hash: string;
      app_bundle_id: string;
      is_valid: boolean;
      created_at: string;
      last_seen: string;
    }>(`/devices/token/${token}`),

  /**
   * Look up a device by its server-assigned ID.
   * @param deviceId - UUID device identifier
   */
  getById: (deviceId: string) =>
    request<{
      device_id: string;
      token_hash: string;
      app_bundle_id: string;
      is_valid: boolean;
      created_at: string;
      last_seen: string;
    }>(`/devices/${deviceId}`),

  /**
   * Invalidate a device token.
   * @param token - 64-character hex device token
   * @param reason - Optional invalidation reason
   */
  invalidate: (token: string, reason?: string) =>
    request<void>(`/devices/token/${token}`, {
      method: 'DELETE',
      body: JSON.stringify({ reason }),
    }),

  /**
   * Subscribe a device to a topic.
   * @param device_token - 64-character hex device token
   * @param topic - Topic name to subscribe to
   */
  subscribe: (device_token: string, topic: string) =>
    request<{ success: boolean; topic: string }>(
      '/devices/topics/subscribe',
      { method: 'POST', body: JSON.stringify({ device_token, topic }) }
    ),

  /**
   * Unsubscribe a device from a topic.
   * @param device_token - 64-character hex device token
   * @param topic - Topic name to unsubscribe from
   */
  unsubscribe: (device_token: string, topic: string) =>
    request<{ success: boolean }>(
      '/devices/topics/unsubscribe',
      { method: 'POST', body: JSON.stringify({ device_token, topic }) }
    ),

  /**
   * Get all topics a device is subscribed to.
   * @param deviceId - UUID device identifier
   */
  getTopics: (deviceId: string) =>
    request<{ device_id: string; topics: string[] }>(`/devices/${deviceId}/topics`),
};

// ============================================================================
// Notifications API
// ============================================================================

/**
 * Notifications API functions for sending push notifications.
 * Used by the admin dashboard's "Send Notification" page.
 */
export const notificationsApi = {
  /**
   * Send a notification to a device by its raw token.
   * @param deviceToken - 64-character hex device token
   * @param payload - APNs payload with aps dictionary
   * @param options - Priority, expiration, and collapse ID options
   */
  sendToDevice: (
    deviceToken: string,
    payload: { aps: { alert?: string | { title?: string; body?: string }; badge?: number; sound?: string } },
    options?: { priority?: number; expiration?: number; collapse_id?: string }
  ) =>
    request<{ notification_id: string; status: string }>(
      `/notifications/device/${deviceToken}`,
      { method: 'POST', body: JSON.stringify({ payload, ...options }) }
    ),

  /**
   * Send a notification to a device by its server-assigned ID.
   * @param deviceId - UUID device identifier
   * @param payload - APNs payload with aps dictionary
   * @param options - Priority, expiration, and collapse ID options
   */
  sendToDeviceById: (
    deviceId: string,
    payload: { aps: { alert?: string | { title?: string; body?: string }; badge?: number; sound?: string } },
    options?: { priority?: number; expiration?: number; collapse_id?: string }
  ) =>
    request<{ notification_id: string; status: string }>(
      `/notifications/device-id/${deviceId}`,
      { method: 'POST', body: JSON.stringify({ payload, ...options }) }
    ),

  /**
   * Send a notification to all subscribers of a topic.
   * @param topic - Topic name
   * @param payload - APNs payload with aps dictionary
   * @param options - Priority, expiration, and collapse ID options
   */
  sendToTopic: (
    topic: string,
    payload: { aps: { alert?: string | { title?: string; body?: string }; badge?: number; sound?: string } },
    options?: { priority?: number; expiration?: number; collapse_id?: string }
  ) =>
    request<{ notification_id: string; status: string; queued_count?: number }>(
      `/notifications/topic/${topic}`,
      { method: 'POST', body: JSON.stringify({ payload, ...options }) }
    ),

  /**
   * Get a notification by its ID.
   * @param notificationId - UUID notification identifier
   */
  getById: (notificationId: string) =>
    request<{
      id: string;
      device_id: string;
      status: string;
      priority: number;
      created_at: string;
      updated_at: string;
      payload: unknown;
    }>(`/notifications/${notificationId}`),

  /**
   * Get just the status of a notification.
   * @param notificationId - UUID notification identifier
   */
  getStatus: (notificationId: string) =>
    request<{
      notification_id: string;
      status: string;
      created_at: string;
      updated_at: string;
    }>(`/notifications/${notificationId}/status`),
};

// ============================================================================
// Feedback API
// ============================================================================

/**
 * Feedback API functions for managing invalid token feedback.
 * App providers use this to learn about tokens that should be removed.
 */
export const feedbackApi = {
  /**
   * Get feedback entries for an app.
   * @param appBundleId - App bundle identifier
   * @param since - Optional ISO date string to filter feedback after
   */
  getForApp: (appBundleId: string, since?: string) => {
    let url = `/feedback/${appBundleId}`;
    if (since) url += `?since=${since}`;
    return request<{ feedback: Array<{
      id: number;
      token_hash: string;
      reason: string;
      timestamp: string;
    }> }>(url);
  },

  /**
   * Clear feedback entries for an app after processing.
   * @param appBundleId - App bundle identifier
   * @param before - Optional ISO date string to clear feedback before
   */
  clear: (appBundleId: string, before?: string) => {
    let url = `/feedback/${appBundleId}`;
    if (before) url += `?before=${before}`;
    return request<{ cleared: number }>(url, { method: 'DELETE' });
  },
};
