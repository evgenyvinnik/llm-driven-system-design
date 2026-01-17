import { v4 as uuid } from 'uuid';
import { query } from '../db/index.js';
import redis from '../db/redis.js';
import { generateChallenge } from '../utils/crypto.js';
import { BiometricSession } from '../types/index.js';

export class BiometricService {
  // Initiate biometric authentication
  async initiateAuth(
    userId: string,
    deviceId: string,
    authType: 'face_id' | 'touch_id' | 'passcode'
  ): Promise<{ sessionId: string; challenge: string }> {
    // Verify device belongs to user
    const deviceResult = await query(
      `SELECT * FROM devices WHERE id = $1 AND user_id = $2 AND status = 'active'`,
      [deviceId, userId]
    );

    if (deviceResult.rows.length === 0) {
      throw new Error('Invalid or inactive device');
    }

    const sessionId = uuid();
    const challenge = generateChallenge();

    await query(
      `INSERT INTO biometric_sessions
        (id, user_id, device_id, auth_type, status, challenge, expires_at)
       VALUES ($1, $2, $3, $4, 'pending', $5, NOW() + INTERVAL '5 minutes')`,
      [sessionId, userId, deviceId, authType, challenge]
    );

    // Store in Redis for fast lookup
    await redis.set(
      `biometric:${sessionId}`,
      JSON.stringify({
        userId,
        deviceId,
        authType,
        challenge,
        status: 'pending',
      }),
      'EX',
      300 // 5 minutes
    );

    return { sessionId, challenge };
  }

  // Verify biometric authentication
  // In a real implementation, this would verify the signature from the Secure Enclave
  async verifyAuth(
    sessionId: string,
    response: string
  ): Promise<{ success: boolean; error?: string }> {
    // Get session from Redis (faster) or database
    let session: any = null;
    const redisData = await redis.get(`biometric:${sessionId}`);

    if (redisData) {
      session = JSON.parse(redisData);
    } else {
      const result = await query(
        `SELECT * FROM biometric_sessions
         WHERE id = $1 AND status = 'pending' AND expires_at > NOW()`,
        [sessionId]
      );
      if (result.rows.length > 0) {
        session = result.rows[0];
      }
    }

    if (!session) {
      return { success: false, error: 'Session not found or expired' };
    }

    // In a real implementation, we would:
    // 1. Verify the signature using the device's public key
    // 2. Check that the challenge matches
    // For simulation, we accept any response

    // Simulate verification (accept if response contains the challenge)
    const isValid = response.includes(session.challenge.substring(0, 10)) || response === 'verified';

    if (!isValid) {
      await this.updateSessionStatus(sessionId, 'failed');
      return { success: false, error: 'Authentication failed' };
    }

    await this.updateSessionStatus(sessionId, 'verified');

    // Extend session expiry
    await redis.set(
      `biometric:${sessionId}`,
      JSON.stringify({ ...session, status: 'verified' }),
      'EX',
      300 // 5 more minutes
    );

    return { success: true };
  }

  // Update session status
  private async updateSessionStatus(
    sessionId: string,
    status: 'verified' | 'failed'
  ): Promise<void> {
    await query(
      `UPDATE biometric_sessions
       SET status = $2, verified_at = CASE WHEN $2 = 'verified' THEN NOW() ELSE NULL END
       WHERE id = $1`,
      [sessionId, status]
    );
  }

  // Get session status
  async getSessionStatus(sessionId: string): Promise<BiometricSession | null> {
    const redisData = await redis.get(`biometric:${sessionId}`);

    if (redisData) {
      return JSON.parse(redisData);
    }

    const result = await query(
      `SELECT * FROM biometric_sessions WHERE id = $1`,
      [sessionId]
    );

    return result.rows[0] || null;
  }

  // Simulate Face ID / Touch ID authentication (for demo purposes)
  async simulateBiometricSuccess(
    sessionId: string
  ): Promise<{ success: boolean; error?: string }> {
    return this.verifyAuth(sessionId, 'verified');
  }
}

export const biometricService = new BiometricService();
