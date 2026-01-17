export interface Video {
  id: string;
  title: string;
  description: string;
  thumbnail_url: string;
  channel_name: string;
  category: string;
  duration_seconds: number;
  total_views: number;
  created_at: string;
  windowViews?: number;
  rank?: number;
}

export interface TrendingData {
  videos: Video[];
  updatedAt: string | null;
}

export interface TrendingResponse {
  category: string;
  videos: Video[];
  updatedAt: string | null;
  count: number;
}

export interface TrendingAllResponse {
  [category: string]: TrendingData;
}

export interface StatsResponse {
  totalViews: number;
  uniqueVideos: number;
  activeCategories: number;
  connectedClients: number;
  lastUpdate: string | null;
}

export interface SSEMessage {
  type: 'connected' | 'trending-update' | 'heartbeat';
  timestamp: string;
  trending?: TrendingAllResponse;
  message?: string;
}
