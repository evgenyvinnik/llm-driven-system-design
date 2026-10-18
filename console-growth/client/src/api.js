// Every API call the client makes, in one place.
import { getOverrides } from './lib/overrides.js';
import { getSessionId } from './lib/session.js';

export class ApiError extends Error {
  constructor(status, type, message) {
    super(message);
    this.status = status;
    this.type = type;
  }
}

function headers() {
  const result = { 'Content-Type': 'application/json', 'X-Session-Id': getSessionId() };
  const overrides = getOverrides();
  if (Object.keys(overrides).length > 0) result['X-Experiment-Overrides'] = JSON.stringify(overrides);
  return result;
}

async function request(method, path, body, { keepalive = false } = {}) {
  const response = await fetch(`/api${path}`, {
    method,
    headers: headers(),
    body: body === undefined ? undefined : JSON.stringify(body),
    keepalive,
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new ApiError(response.status, data?.error?.type ?? 'http_error', data?.error?.message ?? `Request failed (${response.status})`);
  }
  return data;
}

export const api = {
  me: () => request('GET', '/me'),
  updateOrg: (body) => request('PATCH', '/org', body),
  members: () => request('GET', '/org/members'),
  invite: (body) => request('POST', '/org/invites', body),

  keys: () => request('GET', '/keys'),
  createKey: (name) => request('POST', '/keys', { name }),
  updateKey: (id, body) => request('PATCH', `/keys/${id}`, body),
  deleteKey: (id) => request('DELETE', `/keys/${id}`),

  models: () => request('GET', '/workbench/models'),
  complete: (body) => request('POST', '/workbench/complete', body),

  usage: (days) => request('GET', `/usage?days=${days}`),
  limits: () => request('GET', '/limits'),

  billing: () => request('GET', '/billing'),
  buyCredits: (body) => request('POST', '/billing/credits', body),
  updateAutoReload: (body) => request('PUT', '/billing/auto-reload', body),
  plans: () => request('GET', '/plans'),
  contactSales: (message) => request('POST', '/plans/scale/contact', { message }),

  experiments: () => request('GET', '/experiments'),
  logExposure: (key, props) =>
    request('POST', `/experiments/${encodeURIComponent(key)}/exposure`, { props, path: window.location.pathname }, { keepalive: true }),
  sendEvent: (payload) => request('POST', '/events', payload, { keepalive: true }),

  resetData: () => request('POST', '/dev/reset'),
  clearEvents: () => request('POST', '/dev/clear-events'),
  simulateUsage: (days) => request('POST', '/dev/simulate-usage', { days }),
};
