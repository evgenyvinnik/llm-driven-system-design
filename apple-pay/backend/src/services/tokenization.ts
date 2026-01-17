import { v4 as uuid } from 'uuid';
import { query } from '../db/index.js';
import redis from '../db/redis.js';
import {
  generateTokenRef,
  generateDPAN,
  identifyNetwork,
  validateLuhn,
} from '../utils/crypto.js';
import { CardProvisioningRequest, ProvisionedCard } from '../types/index.js';

export class TokenizationService {
  // Provision a new card to a device
  async provisionCard(
    userId: string,
    request: CardProvisioningRequest
  ): Promise<{ success: boolean; card?: Partial<ProvisionedCard>; error?: string }> {
    // Validate card number with Luhn algorithm
    if (!validateLuhn(request.pan)) {
      return { success: false, error: 'Invalid card number' };
    }

    // Identify card network
    const network = identifyNetwork(request.pan);

    // Validate expiry
    const now = new Date();
    const expiryDate = new Date(request.expiry_year, request.expiry_month - 1);
    if (expiryDate < now) {
      return { success: false, error: 'Card has expired' };
    }

    // Verify device belongs to user
    const deviceResult = await query(
      `SELECT * FROM devices WHERE id = $1 AND user_id = $2 AND status = 'active'`,
      [request.device_id, userId]
    );

    if (deviceResult.rows.length === 0) {
      return { success: false, error: 'Invalid or inactive device' };
    }

    // Check if card is already provisioned on this device
    const existingCard = await query(
      `SELECT * FROM provisioned_cards
       WHERE user_id = $1 AND device_id = $2 AND last4 = $3 AND status = 'active'`,
      [userId, request.device_id, request.pan.slice(-4)]
    );

    if (existingCard.rows.length > 0) {
      return { success: false, error: 'Card already provisioned on this device' };
    }

    // Simulate network token request (TSP integration)
    const tokenRef = generateTokenRef();
    const tokenDPAN = generateDPAN(network);

    // Check if this is the first card (make it default)
    const cardCount = await query(
      `SELECT COUNT(*) FROM provisioned_cards WHERE user_id = $1 AND status = 'active'`,
      [userId]
    );
    const isDefault = parseInt(cardCount.rows[0].count) === 0;

    // Store provisioned card
    const cardId = uuid();
    await query(
      `INSERT INTO provisioned_cards
        (id, user_id, device_id, token_ref, token_dpan, network, last4,
         card_type, card_holder_name, expiry_month, expiry_year, is_default, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'active')`,
      [
        cardId,
        userId,
        request.device_id,
        tokenRef,
        tokenDPAN,
        network,
        request.pan.slice(-4),
        'credit', // Simplified - would be determined by network
        request.card_holder_name,
        request.expiry_month,
        request.expiry_year,
        isDefault,
      ]
    );

    // Store token reference in Redis for fast lookup
    await redis.set(
      `token:${tokenRef}`,
      JSON.stringify({
        cardId,
        userId,
        deviceId: request.device_id,
        network,
        tokenDPAN,
      }),
      'EX',
      86400 * 365 // 1 year expiry
    );

    // Simulate Secure Element provisioning
    await this.simulateSecureElementProvisioning(request.device_id, tokenRef, tokenDPAN);

    return {
      success: true,
      card: {
        id: cardId,
        network,
        last4: request.pan.slice(-4),
        card_type: 'credit',
        card_holder_name: request.card_holder_name,
        expiry_month: request.expiry_month,
        expiry_year: request.expiry_year,
        is_default: isDefault,
        status: 'active',
      },
    };
  }

  // Simulate Secure Element token storage
  private async simulateSecureElementProvisioning(
    deviceId: string,
    tokenRef: string,
    tokenDPAN: string
  ): Promise<void> {
    // In a real implementation, this would:
    // 1. Establish secure channel to device's Secure Element
    // 2. Encrypt token data for SE
    // 3. Push token to device via APNs

    await redis.set(
      `se:${deviceId}:${tokenRef}`,
      JSON.stringify({
        tokenDPAN,
        provisionedAt: Date.now(),
        atc: 0, // Application Transaction Counter
      }),
      'EX',
      86400 * 365
    );
  }

  // Get user's provisioned cards
  async getCards(userId: string): Promise<ProvisionedCard[]> {
    const result = await query(
      `SELECT pc.*, d.device_name, d.device_type
       FROM provisioned_cards pc
       JOIN devices d ON pc.device_id = d.id
       WHERE pc.user_id = $1 AND pc.status != 'deleted'
       ORDER BY pc.is_default DESC, pc.provisioned_at DESC`,
      [userId]
    );
    return result.rows;
  }

  // Get a specific card
  async getCard(userId: string, cardId: string): Promise<ProvisionedCard | null> {
    const result = await query(
      `SELECT * FROM provisioned_cards WHERE id = $1 AND user_id = $2`,
      [cardId, userId]
    );
    return result.rows[0] || null;
  }

  // Suspend a card
  async suspendCard(
    userId: string,
    cardId: string,
    reason: string
  ): Promise<{ success: boolean; error?: string }> {
    const card = await this.getCard(userId, cardId);
    if (!card) {
      return { success: false, error: 'Card not found' };
    }

    if (card.status === 'suspended') {
      return { success: false, error: 'Card is already suspended' };
    }

    await query(
      `UPDATE provisioned_cards
       SET status = 'suspended', suspended_at = NOW(), suspend_reason = $3, updated_at = NOW()
       WHERE id = $1 AND user_id = $2`,
      [cardId, userId, reason]
    );

    // Update token status in Redis
    const tokenData = await redis.get(`token:${card.token_ref}`);
    if (tokenData) {
      const data = JSON.parse(tokenData);
      data.status = 'suspended';
      await redis.set(`token:${card.token_ref}`, JSON.stringify(data));
    }

    return { success: true };
  }

  // Reactivate a suspended card
  async reactivateCard(
    userId: string,
    cardId: string
  ): Promise<{ success: boolean; error?: string }> {
    const card = await this.getCard(userId, cardId);
    if (!card) {
      return { success: false, error: 'Card not found' };
    }

    if (card.status !== 'suspended') {
      return { success: false, error: 'Card is not suspended' };
    }

    await query(
      `UPDATE provisioned_cards
       SET status = 'active', suspended_at = NULL, suspend_reason = NULL, updated_at = NOW()
       WHERE id = $1 AND user_id = $2`,
      [cardId, userId]
    );

    return { success: true };
  }

  // Remove a card
  async removeCard(
    userId: string,
    cardId: string
  ): Promise<{ success: boolean; error?: string }> {
    const card = await this.getCard(userId, cardId);
    if (!card) {
      return { success: false, error: 'Card not found' };
    }

    await query(
      `UPDATE provisioned_cards SET status = 'deleted', updated_at = NOW()
       WHERE id = $1 AND user_id = $2`,
      [cardId, userId]
    );

    // Remove from Redis
    await redis.del(`token:${card.token_ref}`);
    await redis.del(`se:${card.device_id}:${card.token_ref}`);

    // If this was the default card, make another card default
    if (card.is_default) {
      await query(
        `UPDATE provisioned_cards
         SET is_default = true, updated_at = NOW()
         WHERE user_id = $1 AND status = 'active'
         ORDER BY provisioned_at DESC
         LIMIT 1`,
        [userId]
      );
    }

    return { success: true };
  }

  // Set default card
  async setDefaultCard(
    userId: string,
    cardId: string
  ): Promise<{ success: boolean; error?: string }> {
    const card = await this.getCard(userId, cardId);
    if (!card) {
      return { success: false, error: 'Card not found' };
    }

    if (card.status !== 'active') {
      return { success: false, error: 'Only active cards can be set as default' };
    }

    // Remove default from all cards
    await query(
      `UPDATE provisioned_cards SET is_default = false, updated_at = NOW()
       WHERE user_id = $1`,
      [userId]
    );

    // Set new default
    await query(
      `UPDATE provisioned_cards SET is_default = true, updated_at = NOW()
       WHERE id = $1 AND user_id = $2`,
      [cardId, userId]
    );

    return { success: true };
  }
}

export const tokenizationService = new TokenizationService();
