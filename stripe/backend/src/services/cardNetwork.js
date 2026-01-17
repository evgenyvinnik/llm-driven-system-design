/**
 * Simulated card network authorization
 * In production, this would connect to Visa, Mastercard, etc.
 */

// Simulated decline codes
const DECLINE_CODES = {
  INSUFFICIENT_FUNDS: 'insufficient_funds',
  CARD_DECLINED: 'card_declined',
  EXPIRED_CARD: 'expired_card',
  INCORRECT_CVC: 'incorrect_cvc',
  PROCESSING_ERROR: 'processing_error',
  FRAUD_SUSPECTED: 'fraudulent',
};

// Test card numbers for different scenarios
const TEST_CARDS = {
  '4242424242424242': { approved: true }, // Success
  '4000000000000002': { approved: false, declineCode: DECLINE_CODES.CARD_DECLINED },
  '4000000000009995': { approved: false, declineCode: DECLINE_CODES.INSUFFICIENT_FUNDS },
  '4000000000000069': { approved: false, declineCode: DECLINE_CODES.EXPIRED_CARD },
  '4000000000000127': { approved: false, declineCode: DECLINE_CODES.INCORRECT_CVC },
  '4000000000000119': { approved: false, declineCode: DECLINE_CODES.PROCESSING_ERROR },
  '4100000000000019': { approved: false, declineCode: DECLINE_CODES.FRAUD_SUSPECTED },
};

/**
 * Generate a random auth code
 */
function generateAuthCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

/**
 * Simulate card network authorization
 */
export async function authorize({ amount, currency, cardToken, merchantId }) {
  // Simulate network latency (50-150ms)
  await new Promise(resolve => setTimeout(resolve, 50 + Math.random() * 100));

  // Check for test card patterns
  const last4 = cardToken?.slice(-4) || '';

  // Find matching test card by last 4 digits
  const testCard = Object.entries(TEST_CARDS).find(
    ([number]) => number.endsWith(last4)
  );

  if (testCard) {
    const [_, result] = testCard;
    if (result.approved) {
      return {
        approved: true,
        authCode: generateAuthCode(),
        network: 'visa',
        networkTransactionId: `nt_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      };
    } else {
      return {
        approved: false,
        declineCode: result.declineCode,
        network: 'visa',
      };
    }
  }

  // Default: approve with 95% success rate for random cards
  if (Math.random() < 0.95) {
    return {
      approved: true,
      authCode: generateAuthCode(),
      network: determineNetwork(cardToken),
      networkTransactionId: `nt_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    };
  }

  return {
    approved: false,
    declineCode: DECLINE_CODES.PROCESSING_ERROR,
    network: determineNetwork(cardToken),
  };
}

/**
 * Simulate card capture (for manual capture flow)
 */
export async function capture({ authCode, amount, currency }) {
  // Simulate network latency
  await new Promise(resolve => setTimeout(resolve, 30 + Math.random() * 50));

  // Captures almost always succeed if auth was successful
  if (Math.random() < 0.99) {
    return {
      captured: true,
      captureId: `cap_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    };
  }

  return {
    captured: false,
    error: 'capture_failed',
  };
}

/**
 * Simulate refund through card network
 */
export async function refund({ authCode, amount, currency }) {
  // Simulate network latency
  await new Promise(resolve => setTimeout(resolve, 40 + Math.random() * 80));

  // Refunds have 98% success rate
  if (Math.random() < 0.98) {
    return {
      refunded: true,
      refundId: `rf_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    };
  }

  return {
    refunded: false,
    error: 'refund_failed',
  };
}

/**
 * Determine card network from token/number
 */
function determineNetwork(cardToken) {
  if (!cardToken) return 'unknown';

  const firstDigit = cardToken.charAt(0);
  switch (firstDigit) {
    case '4':
      return 'visa';
    case '5':
      return 'mastercard';
    case '3':
      return 'amex';
    case '6':
      return 'discover';
    default:
      return 'unknown';
  }
}

/**
 * Validate card expiration
 */
export function isCardExpired(expMonth, expYear) {
  const now = new Date();
  const currentMonth = now.getMonth() + 1;
  const currentYear = now.getFullYear();

  if (expYear < currentYear) return true;
  if (expYear === currentYear && expMonth < currentMonth) return true;
  return false;
}

/**
 * Get card brand from card number
 */
export function getCardBrand(cardNumber) {
  const cleaned = cardNumber.replace(/\s/g, '');

  if (/^4/.test(cleaned)) return 'visa';
  if (/^5[1-5]/.test(cleaned)) return 'mastercard';
  if (/^3[47]/.test(cleaned)) return 'amex';
  if (/^6(?:011|5)/.test(cleaned)) return 'discover';
  if (/^35(?:2[89]|[3-8])/.test(cleaned)) return 'jcb';
  if (/^3(?:0[0-5]|[68])/.test(cleaned)) return 'diners';

  return 'unknown';
}
