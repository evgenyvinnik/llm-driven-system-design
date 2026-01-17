import crypto from 'crypto';

// Generate a unique token reference
export function generateTokenRef(): string {
  return `TOK_${crypto.randomBytes(16).toString('hex').toUpperCase()}`;
}

// Generate a device PAN (tokenized card number)
export function generateDPAN(network: string): string {
  // Token PANs start with specific ranges per network
  const prefixes: Record<string, string> = {
    visa: '4000',
    mastercard: '5000',
    amex: '3400',
  };
  const prefix = prefixes[network] || '4000';
  const random = crypto.randomBytes(6).toString('hex').substring(0, 12);
  return prefix + random;
}

// Generate a payment cryptogram (simulated)
export function generateCryptogram(
  tokenRef: string,
  amount: number,
  merchantId: string,
  timestamp: number
): string {
  const input = `${tokenRef}:${amount}:${merchantId}:${timestamp}`;
  const hash = crypto.createHash('sha256').update(input).digest('hex');
  return hash.substring(0, 16).toUpperCase();
}

// Validate a cryptogram (simulated)
export function validateCryptogram(
  cryptogram: string,
  tokenRef: string,
  amount: number,
  merchantId: string,
  timestamp: number,
  toleranceMs: number = 300000 // 5 minute tolerance
): boolean {
  // Check if timestamp is within tolerance
  const now = Date.now();
  if (Math.abs(now - timestamp) > toleranceMs) {
    return false;
  }

  const expected = generateCryptogram(tokenRef, amount, merchantId, timestamp);
  return crypto.timingSafeEqual(
    Buffer.from(cryptogram),
    Buffer.from(expected)
  );
}

// Generate an authorization code
export function generateAuthCode(): string {
  return crypto.randomBytes(3).toString('hex').toUpperCase();
}

// Simulate card network identification
export function identifyNetwork(pan: string): 'visa' | 'mastercard' | 'amex' {
  const firstDigit = pan[0];
  const firstTwo = pan.substring(0, 2);

  if (firstTwo === '34' || firstTwo === '37') {
    return 'amex';
  }
  if (firstDigit === '5') {
    return 'mastercard';
  }
  return 'visa';
}

// Luhn algorithm for card validation
export function validateLuhn(pan: string): boolean {
  const digits = pan.replace(/\D/g, '');
  let sum = 0;
  let isEven = false;

  for (let i = digits.length - 1; i >= 0; i--) {
    let digit = parseInt(digits[i], 10);

    if (isEven) {
      digit *= 2;
      if (digit > 9) {
        digit -= 9;
      }
    }

    sum += digit;
    isEven = !isEven;
  }

  return sum % 10 === 0;
}

// Mask PAN for display
export function maskPAN(pan: string): string {
  const last4 = pan.slice(-4);
  return `**** **** **** ${last4}`;
}

// Generate secure random challenge for biometric auth
export function generateChallenge(): string {
  return crypto.randomBytes(32).toString('base64');
}
