import type {
  SystemStats,
  RealTimeStats,
  AggregateQueryResult,
  Campaign,
  Ad,
  ClickEvent,
  CampaignSummary
} from '../types';

const API_BASE = '/api/v1';

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

export async function getSystemStats(): Promise<SystemStats> {
  return fetchJson<SystemStats>(`${API_BASE}/admin/stats`);
}

export async function getRealTimeStats(minutes: number = 60): Promise<RealTimeStats> {
  return fetchJson<RealTimeStats>(`${API_BASE}/analytics/realtime?minutes=${minutes}`);
}

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

export async function getCampaigns(): Promise<{ campaigns: Campaign[] }> {
  return fetchJson<{ campaigns: Campaign[] }>(`${API_BASE}/admin/campaigns`);
}

export async function getAds(): Promise<{ ads: Ad[] }> {
  return fetchJson<{ ads: Ad[] }>(`${API_BASE}/admin/ads`);
}

export async function getRecentClicks(limit: number = 100, fraudOnly: boolean = false): Promise<{ clicks: ClickEvent[] }> {
  const params = new URLSearchParams({ limit: limit.toString() });
  if (fraudOnly) params.set('fraud_only', 'true');
  return fetchJson<{ clicks: ClickEvent[] }>(`${API_BASE}/admin/recent-clicks?${params}`);
}

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
