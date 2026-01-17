export interface ClickEvent {
  click_id: string;
  ad_id: string;
  campaign_id: string;
  advertiser_id: string;
  user_id?: string;
  timestamp: Date;
  device_type?: 'desktop' | 'mobile' | 'tablet';
  os?: string;
  browser?: string;
  country?: string;
  region?: string;
  ip_hash?: string;
  is_fraudulent?: boolean;
  fraud_reason?: string;
}

export interface ClickEventInput {
  click_id?: string; // Optional - server can generate if not provided
  ad_id: string;
  campaign_id: string;
  advertiser_id: string;
  user_id?: string;
  timestamp?: string; // ISO string - server will use server time if not provided
  device_type?: 'desktop' | 'mobile' | 'tablet';
  os?: string;
  browser?: string;
  country?: string;
  region?: string;
  ip_hash?: string;
}

export interface ClickAggregate {
  time_bucket: Date;
  ad_id: string;
  campaign_id: string;
  advertiser_id: string;
  country?: string;
  device_type?: string;
  click_count: number;
  unique_users: number;
  fraud_count: number;
}

export interface AggregateQueryParams {
  campaign_id?: string;
  advertiser_id?: string;
  ad_id?: string;
  start_time: Date;
  end_time: Date;
  group_by?: ('hour' | 'day' | 'country' | 'device_type')[];
  granularity?: 'minute' | 'hour' | 'day';
}

export interface AggregateQueryResult {
  data: {
    time_bucket: string;
    ad_id?: string;
    campaign_id?: string;
    country?: string;
    device_type?: string;
    clicks: number;
    unique_users: number;
    fraud_rate: number;
  }[];
  total_clicks: number;
  total_unique_users: number;
  query_time_ms: number;
}

export interface FraudDetectionResult {
  is_fraudulent: boolean;
  reason?: string;
  confidence: number;
}

export interface Ad {
  id: string;
  campaign_id: string;
  name: string;
  creative_url?: string;
  status: 'active' | 'paused' | 'deleted';
  created_at: Date;
}

export interface Campaign {
  id: string;
  advertiser_id: string;
  name: string;
  status: 'active' | 'paused' | 'completed';
  created_at: Date;
}

export interface Advertiser {
  id: string;
  name: string;
  created_at: Date;
}
