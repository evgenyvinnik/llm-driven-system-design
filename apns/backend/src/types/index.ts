export interface DeviceToken {
  device_id: string;
  token_hash: string;
  app_bundle_id: string;
  device_info: DeviceInfo | null;
  is_valid: boolean;
  invalidated_at: Date | null;
  invalidation_reason: string | null;
  created_at: Date;
  last_seen: Date;
}

export interface DeviceInfo {
  platform: string;
  os_version?: string;
  device_model?: string;
  app_version?: string;
  bundle_id?: string;
}

export interface TopicSubscription {
  device_id: string;
  topic: string;
  subscribed_at: Date;
}

export interface Notification {
  id: string;
  device_id: string;
  topic?: string;
  payload: NotificationPayload;
  priority: NotificationPriority;
  expiration?: Date;
  collapse_id?: string;
  status: NotificationStatus;
  created_at: Date;
  updated_at: Date;
}

export interface NotificationPayload {
  aps: APSPayload;
  [key: string]: unknown;
}

export interface APSPayload {
  alert?: string | AlertPayload;
  badge?: number;
  sound?: string | SoundPayload;
  "content-available"?: number;
  "mutable-content"?: number;
  category?: string;
  "thread-id"?: string;
  "target-content-id"?: string;
}

export interface AlertPayload {
  title?: string;
  subtitle?: string;
  body?: string;
  "title-loc-key"?: string;
  "title-loc-args"?: string[];
  "subtitle-loc-key"?: string;
  "subtitle-loc-args"?: string[];
  "loc-key"?: string;
  "loc-args"?: string[];
  "action-loc-key"?: string;
  "launch-image"?: string;
}

export interface SoundPayload {
  critical?: number;
  name?: string;
  volume?: number;
}

export type NotificationPriority = 1 | 5 | 10;

export type NotificationStatus =
  | "pending"
  | "queued"
  | "delivered"
  | "failed"
  | "expired";

export interface PendingNotification {
  id: string;
  device_id: string;
  payload: NotificationPayload;
  priority: NotificationPriority;
  expiration: Date | null;
  collapse_id: string | null;
  created_at: Date;
}

export interface DeliveryLog {
  notification_id: string;
  device_id: string;
  status: NotificationStatus;
  delivered_at: Date | null;
  created_at: Date;
}

export interface FeedbackEntry {
  id: number;
  token_hash: string;
  app_bundle_id: string;
  reason: string;
  timestamp: Date;
  created_at: Date;
}

export interface AdminUser {
  id: string;
  username: string;
  password_hash: string;
  role: string;
  created_at: Date;
  last_login: Date | null;
}

export interface Session {
  id: string;
  admin_id: string;
  token: string;
  expires_at: Date;
  created_at: Date;
}

// API Request/Response types

export interface RegisterDeviceRequest {
  token: string;
  app_bundle_id: string;
  device_info?: DeviceInfo;
}

export interface RegisterDeviceResponse {
  device_id: string;
  is_new: boolean;
}

export interface SendNotificationRequest {
  device_token?: string;
  device_id?: string;
  topic?: string;
  payload: NotificationPayload;
  priority?: NotificationPriority;
  expiration?: number; // Unix timestamp
  collapse_id?: string;
}

export interface SendNotificationResponse {
  notification_id: string;
  status: string;
  queued_count?: number;
}

export interface SubscribeTopicRequest {
  device_token: string;
  topic: string;
}

export interface UnsubscribeTopicRequest {
  device_token: string;
  topic: string;
}

export interface GetFeedbackRequest {
  app_bundle_id: string;
  since?: string; // ISO date string
}

export interface NotificationStats {
  total: number;
  pending: number;
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

// WebSocket message types

export interface WSMessage {
  type: string;
  [key: string]: unknown;
}

export interface WSNotification extends WSMessage {
  type: "notification";
  id: string;
  payload: NotificationPayload;
  priority: NotificationPriority;
}

export interface WSAck extends WSMessage {
  type: "ack";
  notification_id: string;
}

export interface WSConnect extends WSMessage {
  type: "connect";
  device_id: string;
}
