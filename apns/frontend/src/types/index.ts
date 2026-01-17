export interface DeviceToken {
  device_id: string;
  token_hash: string;
  app_bundle_id: string;
  device_info: DeviceInfo | null;
  is_valid: boolean;
  invalidated_at: string | null;
  invalidation_reason: string | null;
  created_at: string;
  last_seen: string;
}

export interface DeviceInfo {
  platform: string;
  os_version?: string;
  device_model?: string;
  app_version?: string;
  bundle_id?: string;
}

export interface Notification {
  id: string;
  device_id: string;
  topic?: string;
  payload: NotificationPayload;
  priority: number;
  expiration?: string;
  collapse_id?: string;
  status: NotificationStatus;
  created_at: string;
  updated_at: string;
}

export interface NotificationPayload {
  aps: APSPayload;
  [key: string]: unknown;
}

export interface APSPayload {
  alert?: string | AlertPayload;
  badge?: number;
  sound?: string;
  "content-available"?: number;
  "mutable-content"?: number;
  category?: string;
  "thread-id"?: string;
}

export interface AlertPayload {
  title?: string;
  subtitle?: string;
  body?: string;
}

export type NotificationStatus =
  | "pending"
  | "queued"
  | "delivered"
  | "failed"
  | "expired";

export interface FeedbackEntry {
  id: number;
  token_hash: string;
  app_bundle_id: string;
  reason: string;
  timestamp: string;
  created_at: string;
}

export interface NotificationStats {
  total: number;
  pending: number;
  queued: number;
  delivered: number;
  failed: number;
  expired: number;
}

export interface DeviceStats {
  total: number;
  valid: number;
  invalid: number;
}

export interface TopicStats {
  topic: string;
  subscriber_count: number;
}

export interface DashboardStats {
  notifications: NotificationStats;
  devices: DeviceStats;
  topics: TopicStats[];
  recent_notifications: Notification[];
}

export interface AdminUser {
  id: string;
  username: string;
  role: string;
}

export interface LoginResponse {
  token: string;
  user: AdminUser;
}

export interface PaginatedResponse<T> {
  items: T[];
  total: number;
}
