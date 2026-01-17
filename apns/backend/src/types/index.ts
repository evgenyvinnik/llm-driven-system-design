/**
 * Represents a registered device token in the APNs system.
 * Each device that wants to receive push notifications must register its token.
 * The token is hashed for security and indexed for fast lookups.
 */
export interface DeviceToken {
  /** Unique identifier for the device, generated server-side */
  device_id: string;
  /** SHA-256 hash of the raw device token for secure storage */
  token_hash: string;
  /** iOS app bundle identifier that registered this token */
  app_bundle_id: string;
  /** Optional metadata about the device (platform, OS version, etc.) */
  device_info: DeviceInfo | null;
  /** Whether the token can receive notifications; false if uninstalled or revoked */
  is_valid: boolean;
  /** Timestamp when the token was invalidated, if applicable */
  invalidated_at: Date | null;
  /** Reason for invalidation (e.g., "Uninstalled", "TokenExpired") */
  invalidation_reason: string | null;
  /** When the device first registered */
  created_at: Date;
  /** Last time the device checked in or received a notification */
  last_seen: Date;
}

/**
 * Metadata about a device, provided during token registration.
 * Used for analytics, debugging, and targeted notifications.
 */
export interface DeviceInfo {
  /** Operating system (e.g., "iOS", "iPadOS") */
  platform: string;
  /** OS version string (e.g., "17.0") */
  os_version?: string;
  /** Device model identifier (e.g., "iPhone15,2") */
  device_model?: string;
  /** Version of the app that registered the token */
  app_version?: string;
  /** App bundle identifier */
  bundle_id?: string;
}

/**
 * Represents a device's subscription to a topic.
 * Topics enable sending notifications to groups of devices without knowing individual tokens.
 */
export interface TopicSubscription {
  /** Device subscribed to the topic */
  device_id: string;
  /** Topic name (e.g., "news.sports", "promotions") */
  topic: string;
  /** When the device subscribed */
  subscribed_at: Date;
}

/**
 * A push notification record stored in the database.
 * Tracks the full lifecycle from creation to delivery or expiration.
 */
export interface Notification {
  /** Unique notification identifier (UUID) */
  id: string;
  /** Target device ID */
  device_id: string;
  /** Topic this notification was sent to, if topic-based delivery */
  topic?: string;
  /** APNs payload containing alert, badge, sound, and custom data */
  payload: NotificationPayload;
  /** Delivery priority: 10 (immediate), 5 (power-efficient), 1 (background) */
  priority: NotificationPriority;
  /** When the notification expires and should no longer be delivered */
  expiration?: Date;
  /** Collapse ID for deduplication; newer notifications replace older ones with same ID */
  collapse_id?: string;
  /** Current delivery status */
  status: NotificationStatus;
  /** When the notification was created */
  created_at: Date;
  /** Last status change timestamp */
  updated_at: Date;
}

/**
 * APNs notification payload structure.
 * Must contain an 'aps' dictionary and can include custom keys for app-specific data.
 * Total payload must not exceed 4KB.
 */
export interface NotificationPayload {
  /** Required APNs payload dictionary */
  aps: APSPayload;
  /** Custom key-value pairs passed to the app */
  [key: string]: unknown;
}

/**
 * The 'aps' dictionary in an APNs payload.
 * Controls how iOS displays and handles the notification.
 */
export interface APSPayload {
  /** Alert text or structured alert object */
  alert?: string | AlertPayload;
  /** App badge number (0 removes badge) */
  badge?: number;
  /** Sound to play: filename or structured sound object */
  sound?: string | SoundPayload;
  /** Set to 1 to enable background app refresh */
  "content-available"?: number;
  /** Set to 1 to allow Notification Service Extension to modify content */
  "mutable-content"?: number;
  /** Notification category for action buttons */
  category?: string;
  /** Thread identifier for notification grouping */
  "thread-id"?: string;
  /** Content ID for relevant notification display */
  "target-content-id"?: string;
}

/**
 * Structured alert content for APNs notifications.
 * Supports localization keys for multi-language apps.
 */
export interface AlertPayload {
  /** Primary alert title */
  title?: string;
  /** Secondary subtitle text */
  subtitle?: string;
  /** Main notification message body */
  body?: string;
  /** Localization key for title */
  "title-loc-key"?: string;
  /** Localization format arguments for title */
  "title-loc-args"?: string[];
  /** Localization key for subtitle */
  "subtitle-loc-key"?: string;
  /** Localization format arguments for subtitle */
  "subtitle-loc-args"?: string[];
  /** Localization key for body text */
  "loc-key"?: string;
  /** Localization format arguments for body */
  "loc-args"?: string[];
  /** Localization key for action button text */
  "action-loc-key"?: string;
  /** Image filename for launch image */
  "launch-image"?: string;
}

/**
 * Structured sound configuration for APNs notifications.
 * Allows critical alerts that bypass Do Not Disturb.
 */
export interface SoundPayload {
  /** Set to 1 for critical alert (bypasses mute/DND, requires entitlement) */
  critical?: number;
  /** Sound filename in app bundle (without extension) */
  name?: string;
  /** Volume level 0.0 to 1.0 for critical alerts */
  volume?: number;
}

/**
 * APNs notification priority levels.
 * - 10: Immediate delivery, wakes device
 * - 5: Power-efficient delivery, may be delayed
 * - 1: Background priority, lowest urgency
 */
export type NotificationPriority = 1 | 5 | 10;

/**
 * Notification delivery status.
 * - pending: Created but not yet processed
 * - queued: Device offline, stored for later delivery
 * - delivered: Successfully sent to device
 * - failed: Delivery failed (invalid token, etc.)
 * - expired: Expiration time passed before delivery
 */
export type NotificationStatus =
  | "pending"
  | "queued"
  | "delivered"
  | "failed"
  | "expired";

/**
 * A notification waiting for delivery to an offline device.
 * Stored in the pending_notifications table for store-and-forward delivery.
 */
export interface PendingNotification {
  /** Notification identifier */
  id: string;
  /** Target device ID */
  device_id: string;
  /** Notification payload */
  payload: NotificationPayload;
  /** Delivery priority */
  priority: NotificationPriority;
  /** Expiration timestamp; null means no expiration */
  expiration: Date | null;
  /** Collapse ID for deduplication */
  collapse_id: string | null;
  /** When queued for pending delivery */
  created_at: Date;
}

/**
 * Delivery log entry for tracking notification delivery history.
 * Provides an audit trail for debugging and analytics.
 */
export interface DeliveryLog {
  /** Associated notification ID */
  notification_id: string;
  /** Target device ID */
  device_id: string;
  /** Final delivery status */
  status: NotificationStatus;
  /** Timestamp when delivered (null if not delivered) */
  delivered_at: Date | null;
  /** Log entry creation time */
  created_at: Date;
}

/**
 * Feedback entry for invalid device tokens.
 * Providers poll this to learn about tokens that should no longer receive notifications.
 * Similar to Apple's Feedback Service for cleaning up invalid tokens.
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
  /** When the token was invalidated */
  timestamp: Date;
  /** When this feedback entry was created */
  created_at: Date;
}

/**
 * Admin dashboard user for managing the APNs system.
 * Provides access to the web interface for monitoring and sending notifications.
 */
export interface AdminUser {
  /** User UUID */
  id: string;
  /** Login username */
  username: string;
  /** SHA-256 hash of the password */
  password_hash: string;
  /** User role (e.g., "admin", "viewer") */
  role: string;
  /** Account creation timestamp */
  created_at: Date;
  /** Last successful login */
  last_login: Date | null;
}

/**
 * Admin session for authenticated dashboard access.
 * Sessions are stored in Redis for fast validation and automatic expiration.
 */
export interface Session {
  /** Session UUID */
  id: string;
  /** Associated admin user ID */
  admin_id: string;
  /** Session bearer token */
  token: string;
  /** Session expiration timestamp */
  expires_at: Date;
  /** Session creation timestamp */
  created_at: Date;
}

// API Request/Response types

/**
 * Request body for device token registration.
 * Called by iOS apps when they receive a device token from APNs.
 */
export interface RegisterDeviceRequest {
  /** Raw 64-character hex device token from iOS */
  token: string;
  /** iOS app bundle identifier */
  app_bundle_id: string;
  /** Optional device metadata */
  device_info?: DeviceInfo;
}

/**
 * Response from device registration.
 */
export interface RegisterDeviceResponse {
  /** Server-assigned device ID for future API calls */
  device_id: string;
  /** True if this was a new registration, false if updating existing token */
  is_new: boolean;
}

/**
 * Request body for sending a push notification.
 * Can target by device token, device ID, or topic.
 */
export interface SendNotificationRequest {
  /** Raw device token (64-char hex) */
  device_token?: string;
  /** Server-assigned device ID */
  device_id?: string;
  /** Topic name for broadcast to subscribers */
  topic?: string;
  /** Notification payload (required) */
  payload: NotificationPayload;
  /** Delivery priority (default: 10) */
  priority?: NotificationPriority;
  /** Expiration as Unix timestamp (seconds since epoch) */
  expiration?: number;
  /** Collapse ID for notification deduplication */
  collapse_id?: string;
}

/**
 * Response from sending a notification.
 */
export interface SendNotificationResponse {
  /** Unique notification ID for status tracking */
  notification_id: string;
  /** Initial status: "delivered", "queued", or "no_subscribers" */
  status: string;
  /** For topic sends, number of devices queued */
  queued_count?: number;
}

/**
 * Request to subscribe a device to a topic.
 */
export interface SubscribeTopicRequest {
  /** Device token to subscribe */
  device_token: string;
  /** Topic name to subscribe to */
  topic: string;
}

/**
 * Request to unsubscribe a device from a topic.
 */
export interface UnsubscribeTopicRequest {
  /** Device token to unsubscribe */
  device_token: string;
  /** Topic name to unsubscribe from */
  topic: string;
}

/**
 * Request to fetch feedback entries for an app.
 */
export interface GetFeedbackRequest {
  /** App bundle ID to get feedback for */
  app_bundle_id: string;
  /** Only return feedback after this ISO date string */
  since?: string;
}

/**
 * Aggregate statistics about notifications in the system.
 */
export interface NotificationStats {
  /** Total number of notifications ever created */
  total: number;
  /** Notifications awaiting processing */
  pending: number;
  /** Successfully delivered notifications */
  delivered: number;
  /** Failed delivery attempts */
  failed: number;
  /** Notifications that expired before delivery */
  expired: number;
}

/**
 * Aggregate statistics about registered devices.
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
 * Statistics for a single topic.
 */
export interface TopicStats {
  /** Topic name */
  topic: string;
  /** Number of valid devices subscribed */
  subscriber_count: number;
}

/**
 * Combined statistics for the admin dashboard.
 */
export interface DashboardStats {
  /** Notification delivery statistics */
  notifications: NotificationStats;
  /** Device registration statistics */
  devices: DeviceStats;
  /** Per-topic subscriber counts */
  topics: TopicStats[];
  /** Most recent notifications for activity feed */
  recent_notifications: Notification[];
}

// WebSocket message types

/**
 * Base WebSocket message structure.
 * All WS messages have a type discriminator for routing.
 */
export interface WSMessage {
  /** Message type discriminator */
  type: string;
  /** Additional message-specific fields */
  [key: string]: unknown;
}

/**
 * WebSocket message for pushing a notification to a connected device.
 */
export interface WSNotification extends WSMessage {
  type: "notification";
  /** Notification ID for acknowledgment */
  id: string;
  /** Notification payload */
  payload: NotificationPayload;
  /** Delivery priority */
  priority: NotificationPriority;
}

/**
 * WebSocket acknowledgment message from device confirming notification receipt.
 */
export interface WSAck extends WSMessage {
  type: "ack";
  /** ID of the acknowledged notification */
  notification_id: string;
}

/**
 * WebSocket connection message from device to register for push delivery.
 */
export interface WSConnect extends WSMessage {
  type: "connect";
  /** Device ID to associate with this WebSocket connection */
  device_id: string;
}
