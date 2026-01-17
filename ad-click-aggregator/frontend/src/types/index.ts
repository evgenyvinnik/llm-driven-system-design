export interface ClickEvent {
  click_id: string;
  ad_id: string;
  campaign_id: string;
  advertiser_id: string;
  user_id?: string;
  timestamp: string;
  device_type?: 'desktop' | 'mobile' | 'tablet';
  country?: string;
  is_fraudulent: boolean;
  fraud_reason?: string;
}

export interface AggregateData {
  time_bucket: string;
  country?: string;
  device_type?: string;
  clicks: number;
  unique_users: number;
  fraud_rate: number;
}

export interface AggregateQueryResult {
  data: AggregateData[];
  total_clicks: number;
  total_unique_users: number;
  query_time_ms: number;
}

export interface RealTimeStats {
  time_series: { timestamp: string; clicks: number }[];
  total_clicks: number;
  clicks_per_minute: number;
}

export interface SystemStats {
  total_clicks: number;
  total_fraud_clicks: number;
  fraud_rate: number;
  total_ads: number;
  total_campaigns: number;
  total_advertisers: number;
  clicks_last_24h: number;
  clicks_last_hour: number;
}

export interface Campaign {
  id: string;
  advertiser_id: string;
  name: string;
  advertiser_name: string;
  status: string;
  created_at: string;
}

export interface Ad {
  id: string;
  campaign_id: string;
  name: string;
  campaign_name: string;
  advertiser_name: string;
  creative_url?: string;
  status: string;
  created_at: string;
}

export interface CampaignSummary {
  total_clicks: number;
  unique_users: number;
  fraud_count: number;
  fraud_rate: number;
  top_countries: { country: string; clicks: number }[];
  top_devices: { device_type: string; clicks: number }[];
}
