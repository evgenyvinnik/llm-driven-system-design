import { v4 as uuid } from 'uuid';
import { query } from '../db/index.js';
import redis from '../db/redis.js';
import { generateCryptogram, generateAuthCode } from '../utils/crypto.js';
import { PaymentRequest, PaymentResult, Transaction } from '../types/index.js';

/**
 * Service responsible for processing Apple Pay transactions.
 * Handles the complete payment flow including cryptogram generation,
 * network authorization simulation, and transaction recording.
 * Also manages refunds and transaction history retrieval.
 */
export class PaymentService {
  /**
   * Processes a payment transaction for a user.
   * Validates the card and merchant, generates a cryptogram (simulating
   * Secure Element operation), authorizes through the simulated network,
   * and records the transaction. Updates the Application Transaction Counter
   * and caches recent transactions for quick access.
   *
   * @param userId - The ID of the user making the payment
   * @param request - Payment details including card, amount, merchant, and type
   * @returns PaymentResult with success status, transaction ID, and auth code or error
   */
  async processPayment(
    userId: string,
    request: PaymentRequest
  ): Promise<PaymentResult> {
    // Get card details
    const cardResult = await query(
      `SELECT * FROM provisioned_cards WHERE id = $1 AND user_id = $2`,
      [request.card_id, userId]
    );

    if (cardResult.rows.length === 0) {
      return { success: false, error: 'Card not found' };
    }

    const card = cardResult.rows[0];

    if (card.status !== 'active') {
      return { success: false, error: `Card is ${card.status}` };
    }

    // Get merchant details
    const merchantResult = await query(
      `SELECT * FROM merchants WHERE id = $1 AND status = 'active'`,
      [request.merchant_id]
    );

    if (merchantResult.rows.length === 0) {
      return { success: false, error: 'Merchant not found' };
    }

    const merchant = merchantResult.rows[0];

    // Generate cryptogram (simulates Secure Element operation)
    const timestamp = Date.now();
    const cryptogram = generateCryptogram(
      card.token_ref,
      request.amount,
      merchant.merchant_id,
      timestamp
    );

    // Simulate transaction processing
    const transactionId = uuid();
    const authResult = await this.simulateNetworkAuthorization(
      card,
      request.amount,
      merchant,
      cryptogram
    );

    // Record transaction
    await query(
      `INSERT INTO transactions
        (id, card_id, merchant_id, token_ref, cryptogram, amount, currency,
         status, auth_code, decline_reason, transaction_type, merchant_name,
         merchant_category)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        transactionId,
        card.id,
        merchant.id,
        card.token_ref,
        cryptogram,
        request.amount,
        request.currency,
        authResult.approved ? 'approved' : 'declined',
        authResult.authCode,
        authResult.declineReason,
        request.transaction_type,
        merchant.name,
        merchant.category_code,
      ]
    );

    // Update Application Transaction Counter in simulated SE
    await this.incrementATC(card.device_id, card.token_ref);

    // Cache recent transaction for quick lookup
    await redis.lpush(
      `transactions:${userId}`,
      JSON.stringify({
        id: transactionId,
        amount: request.amount,
        currency: request.currency,
        merchant: merchant.name,
        status: authResult.approved ? 'approved' : 'declined',
        timestamp,
      })
    );
    await redis.ltrim(`transactions:${userId}`, 0, 99); // Keep last 100
    await redis.expire(`transactions:${userId}`, 86400 * 7); // 7 days

    if (authResult.approved) {
      return {
        success: true,
        transaction_id: transactionId,
        auth_code: authResult.authCode,
      };
    } else {
      return {
        success: false,
        transaction_id: transactionId,
        error: authResult.declineReason,
      };
    }
  }

  /**
   * Simulates card network authorization (Visa, Mastercard, Amex).
   * In a real implementation, this would connect to the actual card
   * networks for real-time authorization. Includes test scenarios
   * for demonstrating declined transactions.
   *
   * @param card - The provisioned card being charged
   * @param amount - The transaction amount
   * @param merchant - The merchant receiving the payment
   * @param cryptogram - The payment cryptogram for verification
   * @returns Authorization result with approval status and auth code or decline reason
   */
  private async simulateNetworkAuthorization(
    card: any,
    amount: number,
    merchant: any,
    cryptogram: string
  ): Promise<{ approved: boolean; authCode?: string; declineReason?: string }> {
    // Simulate various authorization scenarios

    // Check for test decline scenarios
    if (amount === 666.66) {
      return { approved: false, declineReason: 'Insufficient funds' };
    }

    if (amount === 999.99) {
      return { approved: false, declineReason: 'Card declined' };
    }

    // Check for high-value transactions (simulate fraud prevention)
    if (amount > 10000) {
      return { approved: false, declineReason: 'Transaction limit exceeded' };
    }

    // Check card expiry
    const now = new Date();
    const expiryDate = new Date(card.expiry_year, card.expiry_month - 1);
    if (expiryDate < now) {
      return { approved: false, declineReason: 'Card expired' };
    }

    // Simulate random network issues (1% chance)
    if (Math.random() < 0.01) {
      return { approved: false, declineReason: 'Network error - please retry' };
    }

    // Transaction approved
    const authCode = generateAuthCode();
    return { approved: true, authCode };
  }

  /**
   * Increments the Application Transaction Counter for a token.
   * The ATC is used to prevent replay attacks by ensuring each
   * cryptogram is unique. In a real Secure Element, this counter
   * is stored in tamper-resistant hardware.
   *
   * @param deviceId - The device containing the token
   * @param tokenRef - The token reference
   * @returns The new ATC value
   */
  private async incrementATC(deviceId: string, tokenRef: string): Promise<number> {
    const seKey = `se:${deviceId}:${tokenRef}`;
    const seData = await redis.get(seKey);

    if (seData) {
      const data = JSON.parse(seData);
      data.atc = (data.atc || 0) + 1;
      await redis.set(seKey, JSON.stringify(data));
      return data.atc;
    }

    return 0;
  }

  /**
   * Retrieves a specific transaction by ID.
   * Ensures the transaction belongs to the requesting user
   * by joining with their provisioned cards.
   *
   * @param userId - The user's unique identifier
   * @param transactionId - The transaction's unique identifier
   * @returns The transaction if found and owned by user, null otherwise
   */
  async getTransaction(
    userId: string,
    transactionId: string
  ): Promise<Transaction | null> {
    const result = await query(
      `SELECT t.* FROM transactions t
       JOIN provisioned_cards pc ON t.card_id = pc.id
       WHERE t.id = $1 AND pc.user_id = $2`,
      [transactionId, userId]
    );
    return result.rows[0] || null;
  }

  /**
   * Retrieves a paginated list of transactions for a user.
   * Supports filtering by card ID and status. Returns transactions
   * with card details (last4, network) for display purposes.
   *
   * @param userId - The user's unique identifier
   * @param options - Query options for pagination and filtering
   * @param options.limit - Maximum number of transactions to return (default: 50)
   * @param options.offset - Number of transactions to skip (default: 0)
   * @param options.cardId - Filter by specific card ID
   * @param options.status - Filter by transaction status
   * @returns Object with transactions array and total count
   */
  async getTransactions(
    userId: string,
    options: {
      limit?: number;
      offset?: number;
      cardId?: string;
      status?: string;
    } = {}
  ): Promise<{ transactions: Transaction[]; total: number }> {
    const { limit = 50, offset = 0, cardId, status } = options;

    let whereClause = 'pc.user_id = $1';
    const params: any[] = [userId];
    let paramIndex = 2;

    if (cardId) {
      whereClause += ` AND t.card_id = $${paramIndex}`;
      params.push(cardId);
      paramIndex++;
    }

    if (status) {
      whereClause += ` AND t.status = $${paramIndex}`;
      params.push(status);
      paramIndex++;
    }

    const countResult = await query(
      `SELECT COUNT(*) FROM transactions t
       JOIN provisioned_cards pc ON t.card_id = pc.id
       WHERE ${whereClause}`,
      params
    );

    const result = await query(
      `SELECT t.*, pc.last4, pc.network FROM transactions t
       JOIN provisioned_cards pc ON t.card_id = pc.id
       WHERE ${whereClause}
       ORDER BY t.created_at DESC
       LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      [...params, limit, offset]
    );

    return {
      transactions: result.rows,
      total: parseInt(countResult.rows[0].count),
    };
  }

  /**
   * Processes a refund for a previously approved transaction.
   * Creates a new transaction record with negative amount and
   * updates the original transaction status to 'refunded'.
   * Supports partial refunds when amount is specified.
   *
   * @param merchantId - The merchant's unique identifier
   * @param transactionId - The original transaction to refund
   * @param amount - Optional partial refund amount (defaults to full refund)
   * @returns Object with success status and refund transaction ID or error
   */
  async refundTransaction(
    merchantId: string,
    transactionId: string,
    amount?: number
  ): Promise<{ success: boolean; refundId?: string; error?: string }> {
    const result = await query(
      `SELECT * FROM transactions WHERE id = $1 AND merchant_id = $2`,
      [transactionId, merchantId]
    );

    if (result.rows.length === 0) {
      return { success: false, error: 'Transaction not found' };
    }

    const transaction = result.rows[0];

    if (transaction.status !== 'approved') {
      return { success: false, error: 'Only approved transactions can be refunded' };
    }

    const refundAmount = amount || transaction.amount;
    if (refundAmount > transaction.amount) {
      return { success: false, error: 'Refund amount exceeds transaction amount' };
    }

    // Create refund transaction
    const refundId = uuid();
    await query(
      `INSERT INTO transactions
        (id, card_id, merchant_id, token_ref, amount, currency, status,
         transaction_type, merchant_name, merchant_category)
       VALUES ($1, $2, $3, $4, $5, $6, 'approved', 'refund', $7, $8)`,
      [
        refundId,
        transaction.card_id,
        transaction.merchant_id,
        transaction.token_ref,
        -refundAmount,
        transaction.currency,
        transaction.merchant_name,
        transaction.merchant_category,
      ]
    );

    // Update original transaction status
    await query(
      `UPDATE transactions SET status = 'refunded' WHERE id = $1`,
      [transactionId]
    );

    return { success: true, refundId };
  }
}

/** Singleton instance of the PaymentService */
export const paymentService = new PaymentService();
