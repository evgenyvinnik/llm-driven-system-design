/**
 * Represents a user account in the Find My system.
 * Users can register devices and receive notifications about their tracked items.
 */
export interface User {
  id: string;
  email: string;
  password_hash: string;
  name: string;
  role: 'user' | 'admin';
  created_at: Date;
  updated_at: Date;
}

/**
 * A device registered in the Find My network (AirTag, iPhone, MacBook, etc.).
 * Contains the master secret used for end-to-end encryption and key derivation.
 */
export interface RegisteredDevice {
  id: string;
  user_id: string;
  device_type: 'airtag' | 'iphone' | 'macbook' | 'ipad' | 'airpods';
  name: string;
  emoji: string;
  master_secret: string;
  current_period: number;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

/**
 * An encrypted location report submitted by devices in the Find My network.
 * The server stores only encrypted data - it cannot read the actual location.
 */
export interface LocationReport {
  id: number;
  identifier_hash: string;
  encrypted_payload: EncryptedPayload;
  reporter_region?: string;
  created_at: Date;
}

/**
 * ECIES-like encrypted payload structure for location data.
 * Uses AES-256-GCM for authenticated encryption.
 */
export interface EncryptedPayload {
  ephemeralPublicKey: string;
  iv: string;
  ciphertext: string;
  authTag: string;
}

/**
 * Decrypted location data after owner retrieves and decrypts a report.
 * Only the device owner can decrypt location data using their master secret.
 */
export interface DecryptedLocation {
  id: number;
  device_id: string;
  latitude: number;
  longitude: number;
  accuracy?: number;
  address?: string;
  timestamp: Date;
  created_at: Date;
}

/**
 * Lost mode configuration for a device.
 * When enabled, the owner receives notifications when the device is found.
 */
export interface LostMode {
  device_id: string;
  enabled: boolean;
  contact_phone?: string;
  contact_email?: string;
  message?: string;
  notify_when_found: boolean;
  enabled_at?: Date;
  created_at: Date;
  updated_at: Date;
}

/**
 * A notification sent to a user about their devices or security alerts.
 * Supports various types including device found, unknown tracker detection, and system alerts.
 */
export interface Notification {
  id: string;
  user_id: string;
  device_id?: string;
  type: 'device_found' | 'unknown_tracker' | 'low_battery' | 'system';
  title: string;
  message?: string;
  is_read: boolean;
  data?: Record<string, unknown>;
  created_at: Date;
}

/**
 * A sighting of a nearby tracker detected by the anti-stalking system.
 * Used to track unknown trackers traveling with a user.
 */
export interface TrackerSighting {
  id: number;
  user_id: string;
  identifier_hash: string;
  latitude: number;
  longitude: number;
  seen_at: Date;
}

/**
 * Request payload for creating a new device.
 */
export interface CreateDeviceRequest {
  device_type: RegisteredDevice['device_type'];
  name: string;
  emoji?: string;
}

/**
 * Request payload for updating device properties.
 */
export interface UpdateDeviceRequest {
  name?: string;
  emoji?: string;
  is_active?: boolean;
}

/**
 * Request payload for submitting a location report from the finder network.
 */
export interface LocationReportRequest {
  identifier_hash: string;
  encrypted_payload: EncryptedPayload;
  reporter_region?: string;
}

/**
 * Request payload for enabling or updating lost mode settings.
 */
export interface LostModeRequest {
  enabled: boolean;
  contact_phone?: string;
  contact_email?: string;
  message?: string;
  notify_when_found?: boolean;
}

/**
 * Location data for simulating device reports (demo/testing only).
 */
export interface SimulatedLocation {
  latitude: number;
  longitude: number;
  accuracy?: number;
}

/**
 * Session data extension for express-session.
 * Stores authenticated user ID and role for access control.
 */
declare module 'express-session' {
  interface SessionData {
    userId: string;
    role: 'user' | 'admin';
  }
}
