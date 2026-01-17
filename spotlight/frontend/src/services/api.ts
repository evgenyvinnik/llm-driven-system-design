import { SearchResponse, SuggestionsResponse } from '../types/search';

const API_BASE = '/api';

export async function search(query: string, types?: string[]): Promise<SearchResponse> {
  const params = new URLSearchParams({ q: query });
  if (types && types.length > 0) {
    params.append('types', types.join(','));
  }

  const response = await fetch(`${API_BASE}/search?${params}`);
  if (!response.ok) {
    throw new Error('Search failed');
  }

  return response.json();
}

export async function getSuggestions(prefix: string): Promise<{ suggestions: { id: string; type: string; name: string }[] }> {
  const params = new URLSearchParams({ q: prefix });
  const response = await fetch(`${API_BASE}/search/suggest?${params}`);
  if (!response.ok) {
    throw new Error('Suggestions failed');
  }

  return response.json();
}

export async function getProactiveSuggestions(): Promise<SuggestionsResponse> {
  const response = await fetch(`${API_BASE}/suggestions`);
  if (!response.ok) {
    throw new Error('Failed to get suggestions');
  }

  return response.json();
}

export async function recordActivity(type: string, itemId: string, itemName: string, metadata?: Record<string, unknown>): Promise<void> {
  await fetch(`${API_BASE}/suggestions/activity`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type, itemId, itemName, metadata }),
  });
}

export async function recordAppLaunch(bundleId: string): Promise<void> {
  await fetch(`${API_BASE}/suggestions/app-launch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bundleId }),
  });
}
