/**
 * @fileoverview API client for the Ad Click Aggregator backend.
 * Provides typed functions for all backend endpoints including
 * click ingestion, analytics queries, and admin operations.
 */

import type {
  SystemStats,
  RealTimeStats,
  AggregateQueryResult,
  Campaign,
  Ad,
  ClickEvent,
  CampaignSummary
} from '../types';

/** Base URL for all API requests */
const API_BASE = '/api/v1';

/**
 * Generic fetch wrapper that handles JSON responses and errors.
 * Throws on non-2xx responses with error message from server.
 *
 * @template T - Expected response type
 * @param url - Full URL to fetch
 * @param options - Optional fetch configuration
 * @returns Parsed JSON response
 * @throws Error with server message on failure
 */
async function fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    headers: {
      'Content-Type': 'application/json',
    },
    ...options,
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(error.error || 'Request failed');
  }

  return response.json();
}

/**
 * Fetches overall system statistics for the admin dashboard.
 *
 * @returns System-wide metrics including totals and fraud rates
 */
export async function getSystemStats(): Promise<SystemStats> {
  return fetchJson<SystemStats>(`${API_BASE}/admin/stats`);
}

/**
 * Fetches real-time click statistics from the last N minutes.
 *
 * @param minutes - Lookback period in minutes (default: 60)
 * @returns Time series data and throughput metrics
 */
export async function getRealTimeStats(minutes: number = 60): Promise<RealTimeStats> {
  return fetchJson<RealTimeStats>(`${API_BASE}/analytics/realtime?minutes=${minutes}`);
}

/**
 * Queries pre-aggregated click data with filtering and grouping options.
 *
 * @param params - Query parameters for filtering and grouping
 * @returns Aggregated data with totals and query timing
 */
export async function getAggregateData(params: {
  startTime: string;
  endTime: string;
  campaignId?: string;
  advertiserId?: string;
  adId?: string;
  groupBy?: string;
  granularity?: 'minute' | 'hour' | 'day';
}): Promise<AggregateQueryResult> {
  const searchParams = new URLSearchParams({
    start_time: params.startTime,
    end_time: params.endTime,
  });

  if (params.campaignId) searchParams.set('campaign_id', params.campaignId);
  if (params.advertiserId) searchParams.set('advertiser_id', params.advertiserId);
  if (params.adId) searchParams.set('ad_id', params.adId);
  if (params.groupBy) searchParams.set('group_by', params.groupBy);
  if (params.granularity) searchParams.set('granularity', params.granularity);

  return fetchJson<AggregateQueryResult>(`${API_BASE}/analytics/aggregate?${searchParams}`);
}

/**
 * Fetches the list of all campaigns for display and selection.
 *
 * @returns Array of campaigns with advertiser information
 */
export async function getCampaigns(): Promise<{ campaigns: Campaign[] }> {
  return fetchJson<{ campaigns: Campaign[] }>(`${API_BASE}/admin/campaigns`);
}

/**
 * Fetches the list of all ads for display and selection.
 *
 * @returns Array of ads with campaign and advertiser information
 */
export async function getAds(): Promise<{ ads: Ad[] }> {
  return fetchJson<{ ads: Ad[] }>(`${API_BASE}/admin/ads`);
}

/**
 * Fetches recent click events for monitoring.
 *
 * @param limit - Maximum number of clicks to return
 * @param fraudOnly - Filter for fraudulent clicks only
 * @returns Array of recent click events
 */
export async function getRecentClicks(limit: number = 100, fraudOnly: boolean = false): Promise<{ clicks: ClickEvent[] }> {
  const params = new URLSearchParams({ limit: limit.toString() });
  if (fraudOnly) params.set('fraud_only', 'true');
  return fetchJson<{ clicks: ClickEvent[] }>(`${API_BASE}/admin/recent-clicks?${params}`);
}

/**
 * Fetches comprehensive statistics for a specific campaign.
 *
 * @param campaignId - Campaign identifier
 * @param startTime - ISO datetime string for range start
 * @param endTime - ISO datetime string for range end
 * @returns Campaign summary with totals and breakdowns
 */
export async function getCampaignSummary(
  campaignId: string,
  startTime: string,
  endTime: string
): Promise<CampaignSummary> {
  const params = new URLSearchParams({
    start_time: startTime,
    end_time: endTime,
  });
  return fetchJson<CampaignSummary>(`${API_BASE}/analytics/campaign/${campaignId}/summary?${params}`);
}

/**
 * Sends a single test click event to the backend.
 * Used for development and testing the ingestion pipeline.
 *
 * @param clickData - Click event data to submit
 * @returns Processing result with click ID and fraud status
 */
export async function sendTestClick(clickData: {
  ad_id: string;
  campaign_id: string;
  advertiser_id: string;
  user_id?: string;
  device_type?: 'desktop' | 'mobile' | 'tablet';
  country?: string;
}): Promise<{ success: boolean; click_id: string; is_fraudulent: boolean; message: string }> {
  return fetchJson(`${API_BASE}/clicks`, {
    method: 'POST',
    body: JSON.stringify(clickData),
  });
}

/**
 * Sends multiple test click events in a batch.
 * Used for load testing and generating sample data.
 *
 * @param clicks - Array of click events to submit
 * @returns Batch processing summary with counts
 */
export async function sendBatchClicks(clicks: {
  ad_id: string;
  campaign_id: string;
  advertiser_id: string;
  user_id?: string;
  device_type?: 'desktop' | 'mobile' | 'tablet';
  country?: string;
}[]): Promise<{ processed: number; success_count: number; fraud_count: number }> {
  return fetchJson(`${API_BASE}/clicks/batch`, {
    method: 'POST',
    body: JSON.stringify({ clicks }),
  });
}
