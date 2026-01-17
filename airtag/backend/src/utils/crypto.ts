import crypto from 'crypto';

// Key rotation period in milliseconds (15 minutes)
const KEY_ROTATION_PERIOD = 15 * 60 * 1000;

/**
 * Manages key derivation and rotation for AirTag-like devices.
 * Keys rotate every 15 minutes to prevent tracking.
 */
export class KeyManager {
  private masterSecret: string;

  constructor(masterSecret: string) {
    this.masterSecret = masterSecret;
  }

  /**
   * Get the current time period for key rotation
   */
  getCurrentPeriod(): number {
    return Math.floor(Date.now() / KEY_ROTATION_PERIOD);
  }

  /**
   * Derive a key for a specific time period
   */
  deriveKeyForPeriod(period: number): Buffer {
    return crypto
      .createHmac('sha256', this.masterSecret)
      .update(`airtag_key_${period}`)
      .digest();
  }

  /**
   * Get the current period's derived key
   */
  getCurrentKey(): Buffer {
    return this.deriveKeyForPeriod(this.getCurrentPeriod());
  }

  /**
   * Derive a 6-byte identifier from a key (used for BLE advertisement)
   */
  deriveIdentifier(key: Buffer): string {
    return crypto.createHash('sha256').update(key).digest('hex').slice(0, 12);
  }

  /**
   * Get the current identifier hash (what's sent to servers)
   */
  getCurrentIdentifierHash(): string {
    const key = this.getCurrentKey();
    const identifier = this.deriveIdentifier(key);
    return crypto.createHash('sha256').update(identifier).digest('hex');
  }

  /**
   * Get identifier hash for a specific period
   */
  getIdentifierHashForPeriod(period: number): string {
    const key = this.deriveKeyForPeriod(period);
    const identifier = this.deriveIdentifier(key);
    return crypto.createHash('sha256').update(identifier).digest('hex');
  }

  /**
   * Generate all identifier hashes for a time range
   */
  getIdentifierHashesForTimeRange(
    startTime: number,
    endTime: number
  ): Array<{ period: number; identifierHash: string }> {
    const startPeriod = Math.floor(startTime / KEY_ROTATION_PERIOD);
    const endPeriod = Math.floor(endTime / KEY_ROTATION_PERIOD);
    const result = [];

    for (let period = startPeriod; period <= endPeriod; period++) {
      result.push({
        period,
        identifierHash: this.getIdentifierHashForPeriod(period),
      });
    }

    return result;
  }
}

/**
 * Encrypt location data using ECIES-like scheme.
 * In a real system, this would use proper EC cryptography.
 * For this demo, we use symmetric encryption with a shared secret.
 */
export function encryptLocation(
  location: { latitude: number; longitude: number; accuracy?: number },
  sharedSecret: string
): {
  ephemeralPublicKey: string;
  iv: string;
  ciphertext: string;
  authTag: string;
} {
  // Derive encryption key from shared secret
  const encryptionKey = crypto
    .createHash('sha256')
    .update(sharedSecret)
    .update('encryption')
    .digest();

  // Generate random IV
  const iv = crypto.randomBytes(12);

  // Create cipher
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey, iv);

  // Encrypt location data
  const plaintext = JSON.stringify({
    lat: location.latitude,
    lon: location.longitude,
    accuracy: location.accuracy || 10,
    timestamp: Date.now(),
  });

  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);

  // For demo: ephemeral key is derived from random bytes
  const ephemeralKey = crypto.randomBytes(32);

  return {
    ephemeralPublicKey: ephemeralKey.toString('base64'),
    iv: iv.toString('base64'),
    ciphertext: encrypted.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
  };
}

/**
 * Decrypt location data using the shared secret.
 */
export function decryptLocation(
  encryptedPayload: {
    ephemeralPublicKey: string;
    iv: string;
    ciphertext: string;
    authTag: string;
  },
  sharedSecret: string
): { latitude: number; longitude: number; accuracy: number; timestamp: number } | null {
  try {
    // Derive decryption key from shared secret
    const decryptionKey = crypto
      .createHash('sha256')
      .update(sharedSecret)
      .update('encryption')
      .digest();

    // Decode from base64
    const iv = Buffer.from(encryptedPayload.iv, 'base64');
    const ciphertext = Buffer.from(encryptedPayload.ciphertext, 'base64');
    const authTag = Buffer.from(encryptedPayload.authTag, 'base64');

    // Create decipher
    const decipher = crypto.createDecipheriv('aes-256-gcm', decryptionKey, iv);
    decipher.setAuthTag(authTag);

    // Decrypt
    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);

    const data = JSON.parse(decrypted.toString('utf8'));

    return {
      latitude: data.lat,
      longitude: data.lon,
      accuracy: data.accuracy,
      timestamp: data.timestamp,
    };
  } catch (error) {
    console.error('Decryption failed:', error);
    return null;
  }
}

/**
 * Generate a new master secret for a device
 */
export function generateMasterSecret(): string {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Calculate Haversine distance between two points in kilometers
 */
export function haversineDistance(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const R = 6371; // Earth's radius in km
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function toRad(deg: number): number {
  return deg * (Math.PI / 180);
}
