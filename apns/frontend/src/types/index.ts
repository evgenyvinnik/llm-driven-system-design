/**
 * Frontend Type Definitions.
 *
 * TypeScript interfaces for data structures used in the admin dashboard.
 * These mirror the backend types but use string dates for JSON serialization.
 *
 * @module types
 */

/**
 * Represents a registered device token in the APNs system.
 */
export interface DeviceToken {
  /** Unique identifier for the device */
  device_id: string;
  /** SHA-256 hash of the raw device token */
  token_hash: string;
  /** iOS app bundle identifier */
  app_bundle_id: string;
  /** Optional metadata about the device */
  device_info: DeviceInfo | null;
  /** Whether the token can receive notifications */
  is_valid: boolean;
  /** Timestamp when invalidated (ISO string) */
  invalidated_at: string | null;
  /** Reason for invalidation */
  invalidation_reason: string | null;
  /** When the device first registered (ISO string) */
  created_at: string;
  /** Last activity timestamp (ISO string) */
  last_seen: string;
}

/**
 * Metadata about a device.
 */
export interface DeviceInfo {
  /** Operating system (e.g., "iOS") */
  platform: string;
  /** OS version string */
  os_version?: string;
  /** Device model identifier */
  device_model?: string;
  /** App version that registered the token */
  app_version?: string;
  /** App bundle identifier */
  bundle_id?: string;
}

/**
 * A push notification record.
 */
export interface Notification {
  /** Unique notification identifier */
  id: string;
  /** Target device ID */
  device_id: string;
  /** Topic for topic-based delivery */
  topic?: string;
  /** APNs payload */
  payload: NotificationPayload;
  /** Delivery priority (1, 5, or 10) */
  priority: number;
  /** Expiration timestamp (ISO string) */
  expiration?: string;
  /** Collapse ID for deduplication */
  collapse_id?: string;
  /** Current delivery status */
  status: NotificationStatus;
  /** Creation timestamp (ISO string) */
  created_at: string;
  /** Last update timestamp (ISO string) */
  updated_at: string;
}

/**
 * APNs notification payload structure.
 */
export interface NotificationPayload {
  /** Required APNs payload dictionary */
  aps: APSPayload;
  /** Custom key-value pairs */
  [key: string]: unknown;
}

/**
 * The 'aps' dictionary in an APNs payload.
 */
export interface APSPayload {
  /** Alert text or structured alert */
  alert?: string | AlertPayload;
  /** App badge number */
  badge?: number;
  /** Sound to play */
  sound?: string;
  /** Enable background app refresh */
  "content-available"?: number;
  /** Allow content modification */
  "mutable-content"?: number;
  /** Notification category */
  category?: string;
  /** Thread identifier for grouping */
  "thread-id"?: string;
}

/**
 * Structured alert content.
 */
export interface AlertPayload {
  /** Primary alert title */
  title?: string;
  /** Secondary subtitle */
  subtitle?: string;
  /** Main notification body */
  body?: string;
}

/**
 * Notification delivery status.
 */
export type NotificationStatus =
  | "pending"
  | "queued"
  | "delivered"
  | "failed"
  | "expired";

/**
 * Feedback entry for invalid device tokens.
 */
export interface FeedbackEntry {
  /** Auto-incrementing feedback ID */
  id: number;
  /** Hash of the invalidated token */
  token_hash: string;
  /** App bundle ID that owned the token */
  app_bundle_id: string;
  /** Reason for invalidation */
  reason: string;
  /** When the token was invalidated (ISO string) */
  timestamp: string;
  /** When this entry was created (ISO string) */
  created_at: string;
}

/**
 * Aggregate notification statistics.
 */
export interface NotificationStats {
  /** Total notifications ever created */
  total: number;
  /** Notifications awaiting processing */
  pending: number;
  /** Notifications queued for offline devices */
  queued: number;
  /** Successfully delivered notifications */
  delivered: number;
  /** Failed delivery attempts */
  failed: number;
  /** Notifications that expired before delivery */
  expired: number;
}

/**
 * Aggregate device statistics.
 */
export interface DeviceStats {
  /** Total registered devices */
  total: number;
  /** Devices with valid tokens */
  valid: number;
  /** Devices with invalidated tokens */
  invalid: number;
}

/**
 * Per-topic subscriber count.
 */
export interface TopicStats {
  /** Topic name */
  topic: string;
  /** Number of valid subscribers */
  subscriber_count: number;
}

/**
 * Combined dashboard statistics.
 */
export interface DashboardStats {
  /** Notification delivery statistics */
  notifications: NotificationStats;
  /** Device registration statistics */
  devices: DeviceStats;
  /** Per-topic subscriber counts */
  topics: TopicStats[];
  /** Recent notifications for activity feed */
  recent_notifications: Notification[];
}

/**
 * Admin dashboard user.
 */
export interface AdminUser {
  /** User UUID */
  id: string;
  /** Login username */
  username: string;
  /** User role (e.g., "admin", "viewer") */
  role: string;
}

/**
 * Response from login endpoint.
 */
export interface LoginResponse {
  /** Session bearer token */
  token: string;
  /** Authenticated user info */
  user: AdminUser;
}

/**
 * Generic paginated response wrapper.
 */
export interface PaginatedResponse<T> {
  /** Array of items for current page */
  items: T[];
  /** Total count across all pages */
  total: number;
}
