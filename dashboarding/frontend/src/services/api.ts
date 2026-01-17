/**
 * @fileoverview API client for the Dashboarding backend.
 *
 * Provides typed functions for all backend API endpoints including:
 * - Dashboard and panel management
 * - Metric querying and ingestion
 * - Alert rule and instance operations
 *
 * All functions handle JSON serialization and error responses consistently.
 */

import type { Dashboard, Panel, QueryResult, AlertRule, AlertInstance, MetricDefinition } from '../types';

/** Base URL for all API requests */
const API_BASE = '/api/v1';

/**
 * Generic fetch wrapper with JSON handling and error management.
 *
 * @template T - Expected response type
 * @param url - The URL to fetch
 * @param options - Optional fetch configuration
 * @returns The parsed JSON response
 * @throws Error with message from API response on failure
 */
async function fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(error.error || 'Request failed');
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return response.json();
}

// ============================================================================
// Dashboard API
// ============================================================================

/**
 * Fetches all accessible dashboards.
 *
 * @returns Array of dashboard objects
 */
export async function getDashboards(): Promise<Dashboard[]> {
  const data = await fetchJson<{ dashboards: Dashboard[] }>(`${API_BASE}/dashboards`);
  return data.dashboards;
}

/**
 * Fetches a single dashboard by ID, including all panels.
 *
 * @param id - Dashboard UUID
 * @returns Dashboard with panels array
 */
export async function getDashboard(id: string): Promise<Dashboard> {
  return fetchJson<Dashboard>(`${API_BASE}/dashboards/${id}`);
}

/**
 * Creates a new dashboard.
 *
 * @param data - Dashboard creation parameters
 * @returns The newly created dashboard
 */
export async function createDashboard(data: {
  name: string;
  description?: string;
  is_public?: boolean;
}): Promise<Dashboard> {
  return fetchJson<Dashboard>(`${API_BASE}/dashboards`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

/**
 * Updates an existing dashboard.
 *
 * @param id - Dashboard UUID
 * @param data - Partial dashboard properties to update
 * @returns The updated dashboard
 */
export async function updateDashboard(
  id: string,
  data: Partial<{ name: string; description: string; is_public: boolean }>
): Promise<Dashboard> {
  return fetchJson<Dashboard>(`${API_BASE}/dashboards/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

/**
 * Deletes a dashboard by ID.
 *
 * @param id - Dashboard UUID
 */
export async function deleteDashboard(id: string): Promise<void> {
  await fetchJson<void>(`${API_BASE}/dashboards/${id}`, {
    method: 'DELETE',
  });
}

// ============================================================================
// Panel API
// ============================================================================

/**
 * Creates a new panel on a dashboard.
 *
 * @param dashboardId - Parent dashboard UUID
 * @param data - Panel configuration (title, type, query, position, options)
 * @returns The newly created panel
 */
export async function createPanel(
  dashboardId: string,
  data: Omit<Panel, 'id' | 'dashboard_id' | 'created_at' | 'updated_at'>
): Promise<Panel> {
  return fetchJson<Panel>(`${API_BASE}/dashboards/${dashboardId}/panels`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

/**
 * Updates an existing panel.
 *
 * @param dashboardId - Parent dashboard UUID
 * @param panelId - Panel UUID
 * @param data - Partial panel properties to update
 * @returns The updated panel
 */
export async function updatePanel(
  dashboardId: string,
  panelId: string,
  data: Partial<Panel>
): Promise<Panel> {
  return fetchJson<Panel>(`${API_BASE}/dashboards/${dashboardId}/panels/${panelId}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

/**
 * Deletes a panel from a dashboard.
 *
 * @param dashboardId - Parent dashboard UUID
 * @param panelId - Panel UUID
 */
export async function deletePanel(dashboardId: string, panelId: string): Promise<void> {
  await fetchJson<void>(`${API_BASE}/dashboards/${dashboardId}/panels/${panelId}`, {
    method: 'DELETE',
  });
}

/**
 * Fetches time-series data for a panel's visualization.
 *
 * @param dashboardId - Parent dashboard UUID
 * @param panelId - Panel UUID
 * @param startTime - Start of time range
 * @param endTime - End of time range
 * @returns Array of query results with time-series data
 */
export async function getPanelData(
  dashboardId: string,
  panelId: string,
  startTime: Date,
  endTime: Date
): Promise<QueryResult[]> {
  const data = await fetchJson<{ results: QueryResult[] }>(
    `${API_BASE}/dashboards/${dashboardId}/panels/${panelId}/data`,
    {
      method: 'POST',
      body: JSON.stringify({
        start_time: startTime.toISOString(),
        end_time: endTime.toISOString(),
      }),
    }
  );
  return data.results;
}

// ============================================================================
// Metrics API
// ============================================================================

/**
 * Executes a time-series query for metrics.
 *
 * @param params - Query parameters including metric name, time range, and aggregation
 * @returns Array of query results with time-series data
 */
export async function queryMetrics(params: {
  metric_name: string;
  tags?: Record<string, string>;
  start_time: Date;
  end_time: Date;
  aggregation?: string;
  interval?: string;
}): Promise<QueryResult[]> {
  const data = await fetchJson<{ results: QueryResult[] }>(`${API_BASE}/metrics/query`, {
    method: 'POST',
    body: JSON.stringify({
      ...params,
      start_time: params.start_time.toISOString(),
      end_time: params.end_time.toISOString(),
    }),
  });
  return data.results;
}

/**
 * Fetches all unique metric names.
 *
 * @returns Array of metric names
 */
export async function getMetricNames(): Promise<string[]> {
  const data = await fetchJson<{ names: string[] }>(`${API_BASE}/metrics/names`);
  return data.names;
}

/**
 * Fetches metric definitions (metric + tag combinations).
 *
 * @param name - Optional metric name to filter by
 * @returns Array of metric definitions
 */
export async function getMetricDefinitions(name?: string): Promise<MetricDefinition[]> {
  const url = name
    ? `${API_BASE}/metrics/definitions?name=${encodeURIComponent(name)}`
    : `${API_BASE}/metrics/definitions`;
  const data = await fetchJson<{ definitions: MetricDefinition[] }>(url);
  return data.definitions;
}

/**
 * Fetches the latest value for a metric.
 *
 * @param metricName - The metric name
 * @param tags - Optional tag filters
 * @returns Object with value and timestamp
 */
export async function getMetricLatest(
  metricName: string,
  tags?: Record<string, string>
): Promise<{ value: number; time: string }> {
  const url = tags
    ? `${API_BASE}/metrics/latest/${encodeURIComponent(metricName)}?tags=${encodeURIComponent(JSON.stringify(tags))}`
    : `${API_BASE}/metrics/latest/${encodeURIComponent(metricName)}`;
  return fetchJson(url);
}

/**
 * Fetches aggregate statistics for a metric over a time range.
 *
 * @param metricName - The metric name
 * @param startTime - Start of time range
 * @param endTime - End of time range
 * @param tags - Optional tag filters
 * @returns Object with min, max, avg, and count
 */
export async function getMetricStats(
  metricName: string,
  startTime: Date,
  endTime: Date,
  tags?: Record<string, string>
): Promise<{ min: number; max: number; avg: number; count: number }> {
  let url = `${API_BASE}/metrics/stats/${encodeURIComponent(metricName)}?start_time=${startTime.toISOString()}&end_time=${endTime.toISOString()}`;
  if (tags) {
    url += `&tags=${encodeURIComponent(JSON.stringify(tags))}`;
  }
  return fetchJson(url);
}

// ============================================================================
// Alerts API
// ============================================================================

/**
 * Fetches all alert rules.
 *
 * @returns Array of alert rules
 */
export async function getAlertRules(): Promise<AlertRule[]> {
  const data = await fetchJson<{ rules: AlertRule[] }>(`${API_BASE}/alerts/rules`);
  return data.rules;
}

/**
 * Fetches a single alert rule by ID.
 *
 * @param id - Alert rule UUID
 * @returns The alert rule
 */
export async function getAlertRule(id: string): Promise<AlertRule> {
  return fetchJson<AlertRule>(`${API_BASE}/alerts/rules/${id}`);
}

/**
 * Creates a new alert rule.
 *
 * @param data - Alert rule configuration
 * @returns The newly created alert rule
 */
export async function createAlertRule(
  data: Omit<AlertRule, 'id' | 'created_at' | 'updated_at'>
): Promise<AlertRule> {
  return fetchJson<AlertRule>(`${API_BASE}/alerts/rules`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

/**
 * Updates an existing alert rule.
 *
 * @param id - Alert rule UUID
 * @param data - Partial alert rule properties to update
 * @returns The updated alert rule
 */
export async function updateAlertRule(
  id: string,
  data: Partial<AlertRule>
): Promise<AlertRule> {
  return fetchJson<AlertRule>(`${API_BASE}/alerts/rules/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

/**
 * Deletes an alert rule by ID.
 *
 * @param id - Alert rule UUID
 */
export async function deleteAlertRule(id: string): Promise<void> {
  await fetchJson<void>(`${API_BASE}/alerts/rules/${id}`, {
    method: 'DELETE',
  });
}

/**
 * Fetches alert instances (firing and resolved alerts).
 *
 * @param options - Optional filters for rule ID, status, and limit
 * @returns Array of alert instances
 */
export async function getAlertInstances(options?: {
  ruleId?: string;
  status?: 'firing' | 'resolved';
  limit?: number;
}): Promise<AlertInstance[]> {
  const params = new URLSearchParams();
  if (options?.ruleId) params.set('rule_id', options.ruleId);
  if (options?.status) params.set('status', options.status);
  if (options?.limit) params.set('limit', options.limit.toString());

  const data = await fetchJson<{ instances: AlertInstance[] }>(
    `${API_BASE}/alerts/instances?${params.toString()}`
  );
  return data.instances;
}

/**
 * Manually evaluates an alert rule for testing.
 *
 * @param id - Alert rule UUID
 * @returns Evaluation result with should_fire and current_value
 */
export async function evaluateAlertRule(
  id: string
): Promise<{ should_fire: boolean; current_value: number | null }> {
  return fetchJson(`${API_BASE}/alerts/rules/${id}/evaluate`, {
    method: 'POST',
  });
}

/**
 * Ingests metrics into the backend (primarily for testing).
 *
 * @param metrics - Array of metric data points
 * @returns Object with count of accepted metrics
 */
export async function ingestMetrics(
  metrics: Array<{ name: string; value: number; tags?: Record<string, string>; timestamp?: number }>
): Promise<{ accepted: number }> {
  return fetchJson(`${API_BASE}/metrics/ingest`, {
    method: 'POST',
    body: JSON.stringify({ metrics }),
  });
}
