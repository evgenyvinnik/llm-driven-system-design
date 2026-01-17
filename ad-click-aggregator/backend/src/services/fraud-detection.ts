import type { ClickEvent, FraudDetectionResult } from '../types/index.js';
import { trackIpClicks, trackUserClicks } from './redis.js';

// Fraud detection thresholds
const IP_CLICK_THRESHOLD = 100; // Max clicks per IP per minute
const USER_CLICK_THRESHOLD = 50; // Max clicks per user per minute

// Known fraudulent patterns (in production, this would be from a database)
const KNOWN_FRAUDULENT_IPS = new Set<string>();
const KNOWN_FRAUDULENT_USERS = new Set<string>();

export interface FraudCheckContext {
  ipHash?: string;
  userId?: string;
  deviceType?: string;
  country?: string;
  timestamp: Date;
}

/**
 * Detect potential fraud in a click event
 * Returns fraud detection result with reason if fraudulent
 */
export async function detectFraud(click: ClickEvent): Promise<FraudDetectionResult> {
  const reasons: string[] = [];
  let confidence = 0;

  // Check for known fraudulent IPs
  if (click.ip_hash && KNOWN_FRAUDULENT_IPS.has(click.ip_hash)) {
    reasons.push('known_fraudulent_ip');
    confidence = Math.max(confidence, 0.95);
  }

  // Check for known fraudulent users
  if (click.user_id && KNOWN_FRAUDULENT_USERS.has(click.user_id)) {
    reasons.push('known_fraudulent_user');
    confidence = Math.max(confidence, 0.95);
  }

  // Check click velocity per IP
  if (click.ip_hash) {
    const ipClickCount = await trackIpClicks(click.ip_hash);
    if (ipClickCount > IP_CLICK_THRESHOLD) {
      reasons.push(`ip_click_flood:${ipClickCount}`);
      confidence = Math.max(confidence, Math.min(0.9, 0.5 + (ipClickCount - IP_CLICK_THRESHOLD) * 0.01));
    }
  }

  // Check click velocity per user
  if (click.user_id) {
    const userClickCount = await trackUserClicks(click.user_id);
    if (userClickCount > USER_CLICK_THRESHOLD) {
      reasons.push(`user_click_flood:${userClickCount}`);
      confidence = Math.max(confidence, Math.min(0.9, 0.5 + (userClickCount - USER_CLICK_THRESHOLD) * 0.02));
    }
  }

  // Check for suspicious patterns (simplified version)
  // In production, this would involve ML models
  if (isSuspiciousPattern(click)) {
    reasons.push('suspicious_pattern');
    confidence = Math.max(confidence, 0.6);
  }

  return {
    is_fraudulent: reasons.length > 0 && confidence > 0.5,
    reason: reasons.length > 0 ? reasons.join(', ') : undefined,
    confidence,
  };
}

/**
 * Check for suspicious click patterns
 */
function isSuspiciousPattern(click: ClickEvent): boolean {
  // Check for suspicious timing patterns (e.g., exactly on the second)
  const ms = click.timestamp.getMilliseconds();
  if (ms === 0 || ms === 500) {
    return true;
  }

  // Check for missing expected fields (bots often have incomplete data)
  if (!click.device_type && !click.os && !click.browser) {
    return true;
  }

  return false;
}

/**
 * Add an IP to the known fraudulent list
 */
export function flagFraudulentIp(ipHash: string): void {
  KNOWN_FRAUDULENT_IPS.add(ipHash);
}

/**
 * Add a user to the known fraudulent list
 */
export function flagFraudulentUser(userId: string): void {
  KNOWN_FRAUDULENT_USERS.add(userId);
}

/**
 * Check if an IP is flagged as fraudulent
 */
export function isIpFlagged(ipHash: string): boolean {
  return KNOWN_FRAUDULENT_IPS.has(ipHash);
}

/**
 * Check if a user is flagged as fraudulent
 */
export function isUserFlagged(userId: string): boolean {
  return KNOWN_FRAUDULENT_USERS.has(userId);
}
