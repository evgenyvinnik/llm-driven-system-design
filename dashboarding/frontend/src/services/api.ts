import type { Dashboard, Panel, QueryResult, AlertRule, AlertInstance, MetricDefinition } from '../types';

const API_BASE = '/api/v1';

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

// Dashboards
export async function getDashboards(): Promise<Dashboard[]> {
  const data = await fetchJson<{ dashboards: Dashboard[] }>(`${API_BASE}/dashboards`);
  return data.dashboards;
}

export async function getDashboard(id: string): Promise<Dashboard> {
  return fetchJson<Dashboard>(`${API_BASE}/dashboards/${id}`);
}

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

export async function updateDashboard(
  id: string,
  data: Partial<{ name: string; description: string; is_public: boolean }>
): Promise<Dashboard> {
  return fetchJson<Dashboard>(`${API_BASE}/dashboards/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

export async function deleteDashboard(id: string): Promise<void> {
  await fetchJson<void>(`${API_BASE}/dashboards/${id}`, {
    method: 'DELETE',
  });
}

// Panels
export async function createPanel(
  dashboardId: string,
  data: Omit<Panel, 'id' | 'dashboard_id' | 'created_at' | 'updated_at'>
): Promise<Panel> {
  return fetchJson<Panel>(`${API_BASE}/dashboards/${dashboardId}/panels`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

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

export async function deletePanel(dashboardId: string, panelId: string): Promise<void> {
  await fetchJson<void>(`${API_BASE}/dashboards/${dashboardId}/panels/${panelId}`, {
    method: 'DELETE',
  });
}

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

// Metrics
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

export async function getMetricNames(): Promise<string[]> {
  const data = await fetchJson<{ names: string[] }>(`${API_BASE}/metrics/names`);
  return data.names;
}

export async function getMetricDefinitions(name?: string): Promise<MetricDefinition[]> {
  const url = name
    ? `${API_BASE}/metrics/definitions?name=${encodeURIComponent(name)}`
    : `${API_BASE}/metrics/definitions`;
  const data = await fetchJson<{ definitions: MetricDefinition[] }>(url);
  return data.definitions;
}

export async function getMetricLatest(
  metricName: string,
  tags?: Record<string, string>
): Promise<{ value: number; time: string }> {
  const url = tags
    ? `${API_BASE}/metrics/latest/${encodeURIComponent(metricName)}?tags=${encodeURIComponent(JSON.stringify(tags))}`
    : `${API_BASE}/metrics/latest/${encodeURIComponent(metricName)}`;
  return fetchJson(url);
}

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

// Alerts
export async function getAlertRules(): Promise<AlertRule[]> {
  const data = await fetchJson<{ rules: AlertRule[] }>(`${API_BASE}/alerts/rules`);
  return data.rules;
}

export async function getAlertRule(id: string): Promise<AlertRule> {
  return fetchJson<AlertRule>(`${API_BASE}/alerts/rules/${id}`);
}

export async function createAlertRule(
  data: Omit<AlertRule, 'id' | 'created_at' | 'updated_at'>
): Promise<AlertRule> {
  return fetchJson<AlertRule>(`${API_BASE}/alerts/rules`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function updateAlertRule(
  id: string,
  data: Partial<AlertRule>
): Promise<AlertRule> {
  return fetchJson<AlertRule>(`${API_BASE}/alerts/rules/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

export async function deleteAlertRule(id: string): Promise<void> {
  await fetchJson<void>(`${API_BASE}/alerts/rules/${id}`, {
    method: 'DELETE',
  });
}

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

export async function evaluateAlertRule(
  id: string
): Promise<{ should_fire: boolean; current_value: number | null }> {
  return fetchJson(`${API_BASE}/alerts/rules/${id}/evaluate`, {
    method: 'POST',
  });
}

// Ingest metrics (for testing)
export async function ingestMetrics(
  metrics: Array<{ name: string; value: number; tags?: Record<string, string>; timestamp?: number }>
): Promise<{ accepted: number }> {
  return fetchJson(`${API_BASE}/metrics/ingest`, {
    method: 'POST',
    body: JSON.stringify({ metrics }),
  });
}
