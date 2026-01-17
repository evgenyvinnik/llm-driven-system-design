import crypto from 'crypto';

/**
 * Key rotation period in milliseconds.
 * Keys rotate every 15 minutes to prevent tracking by correlating Bluetooth identifiers.
 * This matches Apple's AirTag key rotation design.
 */
const KEY_ROTATION_PERIOD = 15 * 60 * 1000;

/**
 * Manages cryptographic key derivation and rotation for AirTag-like devices.
 * Implements a time-based key rotation scheme where device identifiers change
 * every 15 minutes to prevent passive tracking by third parties.
 *
 * The owner can always locate their device because they possess the master secret
 * and can derive all past and present identifier hashes.
 */
export class KeyManager {
  private masterSecret: string;

  /**
   * Creates a new KeyManager instance.
   * @param masterSecret - The device's master secret used for all key derivations
   */
  constructor(masterSecret: string) {
    this.masterSecret = masterSecret;
  }

  /**
   * Get the current time period for key rotation.
   * @returns The current period number (increments every 15 minutes since epoch)
   */
  getCurrentPeriod(): number {
    return Math.floor(Date.now() / KEY_ROTATION_PERIOD);
  }

  /**
   * Derive a cryptographic key for a specific time period using HMAC-SHA256.
   * @param period - The time period to derive the key for
   * @returns A 256-bit derived key as a Buffer
   */
  deriveKeyForPeriod(period: number): Buffer {
    return crypto
      .createHmac('sha256', this.masterSecret)
      .update(`airtag_key_${period}`)
      .digest();
  }

  /**
   * Get the current period's derived key.
   * @returns The derived key for the current time period
   */
  getCurrentKey(): Buffer {
    return this.deriveKeyForPeriod(this.getCurrentPeriod());
  }

  /**
   * Derive a 6-byte identifier from a key for BLE advertisement.
   * This is what the device broadcasts to nearby phones.
   * @param key - The derived key for the current period
   * @returns A 12-character hex string representing the 6-byte identifier
   */
  deriveIdentifier(key: Buffer): string {
    return crypto.createHash('sha256').update(key).digest('hex').slice(0, 12);
  }

  /**
   * Get the current identifier hash (what's sent to servers).
   * The server stores only the hash, not the raw identifier.
   * @returns SHA-256 hash of the current identifier
   */
  getCurrentIdentifierHash(): string {
    const key = this.getCurrentKey();
    const identifier = this.deriveIdentifier(key);
    return crypto.createHash('sha256').update(identifier).digest('hex');
  }

  /**
   * Get identifier hash for a specific time period.
   * Allows querying historical location reports.
   * @param period - The time period to compute the hash for
   * @returns SHA-256 hash of the identifier for that period
   */
  getIdentifierHashForPeriod(period: number): string {
    const key = this.deriveKeyForPeriod(period);
    const identifier = this.deriveIdentifier(key);
    return crypto.createHash('sha256').update(identifier).digest('hex');
  }

  /**
   * Generate all identifier hashes for a time range.
   * Used to query location reports across multiple key rotation periods.
   * @param startTime - Start timestamp in milliseconds
   * @param endTime - End timestamp in milliseconds
   * @returns Array of period numbers and their corresponding identifier hashes
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
 * Encrypt location data using an ECIES-like scheme.
 * In production, this would use proper EC cryptography (P-224 curve).
 * For this demo, we use AES-256-GCM symmetric encryption with a shared secret.
 *
 * @param location - The location data to encrypt
 * @param location.latitude - Latitude coordinate
 * @param location.longitude - Longitude coordinate
 * @param location.accuracy - Optional accuracy in meters
 * @param sharedSecret - The master secret used to derive the encryption key
 * @returns Encrypted payload containing ephemeral key, IV, ciphertext, and auth tag
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
 * Only the device owner can decrypt because they have the master secret.
 *
 * @param encryptedPayload - The encrypted payload from a location report
 * @param sharedSecret - The master secret used to derive the decryption key
 * @returns Decrypted location data, or null if decryption fails
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
 * Generate a new cryptographically secure master secret for a device.
 * The master secret is the root of all cryptographic operations for the device.
 * @returns A 64-character hex string (256 bits of entropy)
 */
export function generateMasterSecret(): string {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Calculate Haversine distance between two GPS coordinates.
 * Used by the anti-stalking system to determine if a tracker is following the user.
 *
 * @param lat1 - Latitude of first point in degrees
 * @param lon1 - Longitude of first point in degrees
 * @param lat2 - Latitude of second point in degrees
 * @param lon2 - Longitude of second point in degrees
 * @returns Distance between the two points in kilometers
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

/**
 * Convert degrees to radians for Haversine formula.
 * @param deg - Angle in degrees
 * @returns Angle in radians
 */
function toRad(deg: number): number {
  return deg * (Math.PI / 180);
}
