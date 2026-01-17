export interface User {
  id: string;
  email: string;
  name: string;
  role: 'user' | 'admin';
}

export interface AuthState {
  token: string | null;
  user: User | null;
  isAuthenticated: boolean;
}

export interface Notification {
  id: string;
  user_id: string;
  template_id: string | null;
  content: Record<string, unknown>;
  channels: string[];
  priority: 'critical' | 'high' | 'normal' | 'low';
  status: 'pending' | 'scheduled' | 'delivered' | 'failed' | 'cancelled' | 'partial' | 'partial_success';
  scheduled_at: string | null;
  created_at: string;
  delivered_at: string | null;
  delivery_statuses?: DeliveryStatus[];
}

export interface DeliveryStatus {
  notification_id: string;
  channel: string;
  status: string;
  details: Record<string, unknown>;
  attempts: number;
  updated_at: string;
}

export interface Preferences {
  channels: {
    push: { enabled: boolean };
    email: { enabled: boolean };
    sms: { enabled: boolean };
  };
  categories: Record<string, boolean>;
  quietHoursStart: number | null;
  quietHoursEnd: number | null;
  timezone: string;
}

export interface Template {
  id: string;
  name: string;
  description: string | null;
  channels: Record<string, Record<string, string>>;
  variables: string[];
  created_at: string;
  updated_at: string;
}

export interface Campaign {
  id: string;
  name: string;
  description: string | null;
  template_id: string | null;
  target_audience: Record<string, unknown>;
  channels: string[];
  priority: string;
  status: 'draft' | 'scheduled' | 'running' | 'completed' | 'cancelled';
  scheduled_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  total_sent?: number;
  total_delivered?: number;
  total_opened?: number;
  total_clicked?: number;
  total_failed?: number;
}

export interface RateLimitUsage {
  push: { used: number; limit: number; remaining: number };
  email: { used: number; limit: number; remaining: number };
  sms: { used: number; limit: number; remaining: number };
}

export interface AdminStats {
  notifications: {
    total: number;
    delivered: number;
    pending: number;
    failed: number;
  };
  deliveryByChannel: Record<string, Record<string, number>>;
  users: {
    total_users: number;
    new_users: number;
  };
  queueDepth: Record<string, Record<string, number>>;
  timeRange: string;
}
