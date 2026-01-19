import { query } from '../db/pool.js';

/**
 * Simplified fraud detection service
 * In production, this would use ML models and more sophisticated signals
 */

// Interfaces
export interface PaymentIntent {
  id: string;
  amount: number;
  currency: string;
  status: string;
}

export interface PaymentMethod {
  id: string;
  card_token?: string;
}

export interface RiskSignal {
  rule: string;
  score: number;
  details: string;
}

export interface RiskAssessmentResult {
  riskScore: number;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  signals: RiskSignal[];
  decision: 'allow' | 'review' | 'block';
}

export interface RiskAssessmentParams {
  paymentIntent: PaymentIntent;
  paymentMethod: PaymentMethod | null;
  merchantId: string;
  ipAddress?: string;
}

export interface RiskAssessmentRow {
  id: string;
  payment_intent_id: string;
  risk_score: string;
  risk_level: string;
  signals: string;
  decision: string;
  created_at: Date;
}

const RISK_THRESHOLDS = {
  low: 0.3,
  medium: 0.6,
  high: 0.8,
} as const;

/**
 * Assess risk for a payment
 */
export async function assessRisk({
  paymentIntent,
  paymentMethod,
  merchantId,
  ipAddress,
}: RiskAssessmentParams): Promise<RiskAssessmentResult> {
  const signals: RiskSignal[] = [];
  let totalScore = 0;

  // 1. Velocity check - too many charges in short time
  const velocityResult = await checkVelocity(paymentMethod?.id, merchantId);
  if (velocityResult.score > 0) {
    signals.push(velocityResult);
    totalScore += velocityResult.score;
  }

  // 2. Amount check - unusually high amount
  const amountResult = await checkAmount(paymentIntent.amount, merchantId);
  if (amountResult.score > 0) {
    signals.push(amountResult);
    totalScore += amountResult.score;
  }

  // 3. Card country check (simulated)
  const geoResult = checkGeoMismatch(paymentMethod, ipAddress);
  if (geoResult.score > 0) {
    signals.push(geoResult);
    totalScore += geoResult.score;
  }

  // 4. New payment method check
  const newPmResult = await checkNewPaymentMethod(paymentMethod);
  if (newPmResult.score > 0) {
    signals.push(newPmResult);
    totalScore += newPmResult.score;
  }

  // 5. Time-based check (unusual hours)
  const timeResult = checkUnusualTime();
  if (timeResult.score > 0) {
    signals.push(timeResult);
    totalScore += timeResult.score;
  }

  // Normalize score to 0-1 range
  const riskScore = Math.min(totalScore, 1);

  // Determine risk level
  let riskLevel: 'low' | 'medium' | 'high' | 'critical';
  if (riskScore >= RISK_THRESHOLDS.high) {
    riskLevel = 'critical';
  } else if (riskScore >= RISK_THRESHOLDS.medium) {
    riskLevel = 'high';
  } else if (riskScore >= RISK_THRESHOLDS.low) {
    riskLevel = 'medium';
  } else {
    riskLevel = 'low';
  }

  // Determine action
  let decision: 'allow' | 'review' | 'block';
  if (riskScore >= 0.8) {
    decision = 'block';
  } else if (riskScore >= 0.5) {
    decision = 'review';
  } else {
    decision = 'allow';
  }

  // Log the assessment
  await logRiskAssessment(paymentIntent.id, riskScore, riskLevel, signals, decision);

  return {
    riskScore,
    riskLevel,
    signals,
    decision,
  };
}

/**
 * Check payment velocity
 */
async function checkVelocity(
  paymentMethodId: string | undefined,
  merchantId: string
): Promise<RiskSignal> {
  if (!paymentMethodId) {
    return { rule: 'velocity', score: 0, details: 'No payment method' };
  }

  // Check recent charges with this payment method
  const result = await query<{ count: string }>(
    `
    SELECT COUNT(*) as count
    FROM payment_intents
    WHERE payment_method_id = $1
      AND status = 'succeeded'
      AND created_at > NOW() - INTERVAL '1 hour'
  `,
    [paymentMethodId]
  );

  const count = parseInt(result.rows[0].count);

  if (count >= 5) {
    return { rule: 'velocity_1h', score: 0.5, details: `${count} charges in last hour` };
  } else if (count >= 3) {
    return { rule: 'velocity_1h', score: 0.3, details: `${count} charges in last hour` };
  }

  return { rule: 'velocity', score: 0, details: 'Normal velocity' };
}

/**
 * Check if amount is unusually high for merchant
 */
async function checkAmount(amount: number, merchantId: string): Promise<RiskSignal> {
  // Get merchant's average transaction amount
  const result = await query<{ avg_amount: string | null; stddev_amount: string | null }>(
    `
    SELECT AVG(amount) as avg_amount, STDDEV(amount) as stddev_amount
    FROM payment_intents
    WHERE merchant_id = $1
      AND status = 'succeeded'
      AND created_at > NOW() - INTERVAL '30 days'
  `,
    [merchantId]
  );

  const avgAmount = parseFloat(result.rows[0].avg_amount || '0');
  const stddevAmount = parseFloat(result.rows[0].stddev_amount || '0');

  if (avgAmount === 0) {
    // New merchant, no history
    if (amount > 100000) {
      // > $1000
      return { rule: 'high_amount_new_merchant', score: 0.2, details: 'High amount for new merchant' };
    }
    return { rule: 'amount', score: 0, details: 'New merchant' };
  }

  // Check if amount is significantly higher than average
  const threshold = avgAmount + 2 * stddevAmount;
  if (amount > threshold && amount > avgAmount * 3) {
    return { rule: 'high_amount', score: 0.3, details: `Amount ${amount} vs avg ${Math.round(avgAmount)}` };
  }

  return { rule: 'amount', score: 0, details: 'Normal amount' };
}

/**
 * Check for geographic mismatch (simulated)
 */
function checkGeoMismatch(
  paymentMethod: PaymentMethod | null,
  ipAddress?: string
): RiskSignal {
  // In real implementation, this would use GeoIP lookup
  // For demo, simulate based on payment method properties
  if (!paymentMethod) {
    return { rule: 'geo', score: 0, details: 'No payment method' };
  }

  // Simulate random geo mismatch for demo (10% chance)
  if (Math.random() < 0.1) {
    return { rule: 'geo_mismatch', score: 0.25, details: 'Card country differs from IP country' };
  }

  return { rule: 'geo', score: 0, details: 'Geographic match' };
}

/**
 * Check if payment method is very new
 */
async function checkNewPaymentMethod(paymentMethod: PaymentMethod | null): Promise<RiskSignal> {
  if (!paymentMethod) {
    return { rule: 'new_pm', score: 0, details: 'No payment method' };
  }

  // Check if created in last hour
  const result = await query<{ created_at: Date }>(
    `
    SELECT created_at FROM payment_methods WHERE id = $1
  `,
    [paymentMethod.id]
  );

  if (result.rows.length === 0) {
    return { rule: 'new_pm', score: 0.1, details: 'Unknown payment method' };
  }

  const createdAt = new Date(result.rows[0].created_at);
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000);

  if (createdAt > hourAgo) {
    return { rule: 'new_pm', score: 0.15, details: 'Payment method created recently' };
  }

  return { rule: 'new_pm', score: 0, details: 'Established payment method' };
}

/**
 * Check for unusual transaction time
 */
function checkUnusualTime(): RiskSignal {
  const hour = new Date().getHours();

  // Consider 2 AM - 5 AM as unusual (for demo purposes)
  if (hour >= 2 && hour <= 5) {
    return { rule: 'unusual_time', score: 0.1, details: `Transaction at ${hour}:00` };
  }

  return { rule: 'time', score: 0, details: 'Normal hours' };
}

/**
 * Log risk assessment to database
 */
async function logRiskAssessment(
  paymentIntentId: string,
  riskScore: number,
  riskLevel: string,
  signals: RiskSignal[],
  decision: string
): Promise<void> {
  try {
    await query(
      `
      INSERT INTO risk_assessments
        (payment_intent_id, risk_score, risk_level, signals, decision)
      VALUES ($1, $2, $3, $4, $5)
    `,
      [paymentIntentId, riskScore, riskLevel, JSON.stringify(signals), decision]
    );
  } catch (error) {
    console.error('Failed to log risk assessment:', error);
  }
}

/**
 * Get risk assessment for a payment intent
 */
export async function getRiskAssessment(
  paymentIntentId: string
): Promise<RiskAssessmentRow | null> {
  const result = await query<RiskAssessmentRow>(
    `
    SELECT * FROM risk_assessments
    WHERE payment_intent_id = $1
    ORDER BY created_at DESC
    LIMIT 1
  `,
    [paymentIntentId]
  );

  return result.rows[0] || null;
}
