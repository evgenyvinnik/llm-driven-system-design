import type { Video, TrendingResponse, TrendingAllResponse, StatsResponse } from '../types';

const API_BASE = '/api';

export async function fetchTrending(category: string = 'all'): Promise<TrendingResponse> {
  const response = await fetch(`${API_BASE}/trending?category=${category}`);
  if (!response.ok) {
    throw new Error('Failed to fetch trending videos');
  }
  return response.json();
}

export async function fetchAllTrending(): Promise<TrendingAllResponse> {
  const response = await fetch(`${API_BASE}/trending/all`);
  if (!response.ok) {
    throw new Error('Failed to fetch all trending videos');
  }
  return response.json();
}

export async function fetchCategories(): Promise<{ categories: string[] }> {
  const response = await fetch(`${API_BASE}/trending/categories`);
  if (!response.ok) {
    throw new Error('Failed to fetch categories');
  }
  return response.json();
}

export async function fetchStats(): Promise<StatsResponse> {
  const response = await fetch(`${API_BASE}/trending/stats`);
  if (!response.ok) {
    throw new Error('Failed to fetch stats');
  }
  return response.json();
}

export async function recordView(videoId: string): Promise<{ success: boolean; totalViews: number }> {
  const response = await fetch(`${API_BASE}/videos/${videoId}/view`, {
    method: 'POST',
  });
  if (!response.ok) {
    throw new Error('Failed to record view');
  }
  return response.json();
}

export async function fetchVideos(
  page: number = 1,
  limit: number = 20,
  category?: string
): Promise<{ videos: Video[]; pagination: { page: number; limit: number; total: number; totalPages: number } }> {
  const params = new URLSearchParams({ page: String(page), limit: String(limit) });
  if (category && category !== 'all') {
    params.set('category', category);
  }
  const response = await fetch(`${API_BASE}/videos?${params}`);
  if (!response.ok) {
    throw new Error('Failed to fetch videos');
  }
  return response.json();
}

export async function refreshTrending(): Promise<void> {
  const response = await fetch(`${API_BASE}/trending/refresh`, {
    method: 'POST',
  });
  if (!response.ok) {
    throw new Error('Failed to refresh trending');
  }
}

export async function batchRecordViews(views: { videoId: string; count: number }[]): Promise<void> {
  const response = await fetch(`${API_BASE}/videos/batch-view`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ views }),
  });
  if (!response.ok) {
    throw new Error('Failed to batch record views');
  }
}
