import type { PaymentMethod } from '../types/index.js';

interface FraudEvaluationInput {
  amount: number;
  currency: string;
  payment_method: PaymentMethod;
  merchantId: string;
  customerEmail?: string;
  ipAddress?: string;
}

/**
 * Simple rule-based fraud detection service
 * In production, this would integrate with ML models and external services
 */
export class FraudService {
  private blockThreshold = parseInt(process.env.FRAUD_BLOCK_THRESHOLD || '90', 10);
  private reviewThreshold = parseInt(process.env.FRAUD_REVIEW_THRESHOLD || '70', 10);

  /**
   * Evaluate transaction risk and return a score from 0-100
   * Higher score = higher risk
   */
  async evaluate(input: FraudEvaluationInput): Promise<number> {
    let score = 0;

    // Amount-based rules
    score += this.evaluateAmount(input.amount);

    // Payment method rules
    score += this.evaluatePaymentMethod(input.payment_method);

    // Email-based rules
    if (input.customerEmail) {
      score += this.evaluateEmail(input.customerEmail);
    }

    // Velocity checks (simplified - in production would check Redis/DB)
    score += await this.evaluateVelocity(input.merchantId, input.customerEmail);

    // Cap at 100
    return Math.min(score, 100);
  }

  /**
   * Check if score exceeds block threshold
   */
  shouldBlock(score: number): boolean {
    return score >= this.blockThreshold;
  }

  /**
   * Check if score requires review
   */
  requiresReview(score: number): boolean {
    return score >= this.reviewThreshold && score < this.blockThreshold;
  }

  /**
   * Amount-based risk evaluation
   */
  private evaluateAmount(amount: number): number {
    // Amount in cents
    if (amount > 1000000) {
      // Over $10,000
      return 30;
    } else if (amount > 500000) {
      // Over $5,000
      return 20;
    } else if (amount > 100000) {
      // Over $1,000
      return 10;
    } else if (amount < 100) {
      // Under $1 - could be card testing
      return 15;
    }
    return 0;
  }

  /**
   * Payment method risk evaluation
   */
  private evaluatePaymentMethod(method: PaymentMethod): number {
    let score = 0;

    // Test card numbers
    if (method.last_four === '4242' || method.last_four === '0000') {
      score += 10;
    }

    // Certain card brands have higher fraud rates (simplified)
    if (method.card_brand === 'prepaid') {
      score += 15;
    }

    // Cards expiring soon might be stolen
    if (method.exp_month && method.exp_year) {
      const now = new Date();
      const expiry = new Date(method.exp_year, method.exp_month - 1);
      const monthsUntilExpiry =
        (expiry.getFullYear() - now.getFullYear()) * 12 +
        (expiry.getMonth() - now.getMonth());

      if (monthsUntilExpiry <= 1) {
        score += 10;
      }
    }

    return score;
  }

  /**
   * Email-based risk evaluation
   */
  private evaluateEmail(email: string): number {
    let score = 0;

    // Disposable email domains
    const disposableDomains = [
      'tempmail.com',
      'throwaway.com',
      'mailinator.com',
      'guerrillamail.com',
    ];
    const domain = email.split('@')[1]?.toLowerCase();

    if (domain && disposableDomains.includes(domain)) {
      score += 25;
    }

    // Random-looking emails
    const localPart = email.split('@')[0];
    if (localPart && localPart.length > 20 && /^[a-z0-9]+$/i.test(localPart)) {
      score += 10;
    }

    return score;
  }

  /**
   * Velocity checks - transaction frequency
   * In production, this would check actual transaction history
   */
  private async evaluateVelocity(
    merchantId: string,
    customerEmail?: string
  ): Promise<number> {
    // Simplified - in production would query Redis for recent transaction counts
    // For demo purposes, we'll return a random low score

    // This would typically check:
    // - Transactions from same card in last hour
    // - Transactions from same IP in last hour
    // - Transactions from same email in last hour
    // - Transactions to same merchant from different cards

    return Math.floor(Math.random() * 10);
  }

  /**
   * Get risk level description
   */
  getRiskLevel(score: number): 'low' | 'medium' | 'high' | 'critical' {
    if (score < 30) return 'low';
    if (score < 50) return 'medium';
    if (score < 70) return 'high';
    return 'critical';
  }
}
