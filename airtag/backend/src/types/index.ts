export interface User {
  id: string;
  email: string;
  password_hash: string;
  name: string;
  role: 'user' | 'admin';
  created_at: Date;
  updated_at: Date;
}

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

export interface LocationReport {
  id: number;
  identifier_hash: string;
  encrypted_payload: EncryptedPayload;
  reporter_region?: string;
  created_at: Date;
}

export interface EncryptedPayload {
  ephemeralPublicKey: string;
  iv: string;
  ciphertext: string;
  authTag: string;
}

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

export interface TrackerSighting {
  id: number;
  user_id: string;
  identifier_hash: string;
  latitude: number;
  longitude: number;
  seen_at: Date;
}

// API Request/Response types
export interface CreateDeviceRequest {
  device_type: RegisteredDevice['device_type'];
  name: string;
  emoji?: string;
}

export interface UpdateDeviceRequest {
  name?: string;
  emoji?: string;
  is_active?: boolean;
}

export interface LocationReportRequest {
  identifier_hash: string;
  encrypted_payload: EncryptedPayload;
  reporter_region?: string;
}

export interface LostModeRequest {
  enabled: boolean;
  contact_phone?: string;
  contact_email?: string;
  message?: string;
  notify_when_found?: boolean;
}

export interface SimulatedLocation {
  latitude: number;
  longitude: number;
  accuracy?: number;
}

// Session types
declare module 'express-session' {
  interface SessionData {
    userId: string;
    role: 'user' | 'admin';
  }
}
