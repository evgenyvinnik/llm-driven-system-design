/**
 * Exact fixed-point arithmetic for money and quantities.
 *
 * Every amount is a BigInt holding the value scaled by 10^18, which is the
 * same scale as the DECIMAL(28,18) columns in Postgres. Conversion happens
 * only at the boundaries (API strings in, SQL strings out), so the matching
 * engine compares and subtracts integers and can never drift the way float64
 * does (0.1 + 0.2 !== 0.3).
 */

export const SCALE = 18;
export const ONE = 10n ** BigInt(SCALE);

/** DECIMAL(28,18) leaves room for 10 integer digits. */
const MAX_INTEGER_DIGITS = 10;
const DECIMAL_RE = /^(\d+)(?:\.(\d+))?$/;

/**
 * Parses a plain decimal string ("1", "0.5", "65000.25") into a scaled BigInt.
 * Rejects signs, exponents, whitespace, junk suffixes ("12abc"), more than
 * `maxDecimals` significant fractional digits, and values that overflow the
 * column. Returns null on any rejection so callers decide the error message.
 */
export function parseDecimal(input: unknown, maxDecimals: number = SCALE): bigint | null {
  if (typeof input !== 'string') return null;
  const match = DECIMAL_RE.exec(input);
  if (!match) return null;

  const integerPart = match[1].replace(/^0+(?=\d)/, '');
  const fraction = (match[2] ?? '').replace(/0+$/, '');
  if (integerPart.length > MAX_INTEGER_DIGITS) return null;
  if (fraction.length > Math.min(maxDecimals, SCALE)) return null;

  return BigInt(integerPart) * ONE + BigInt(fraction.padEnd(SCALE, '0') || '0');
}

/** Formats a scaled BigInt as a plain decimal string with no trailing zeros. */
export function toDecimalString(value: bigint): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const integerPart = abs / ONE;
  const fraction = (abs % ONE).toString().padStart(SCALE, '0').replace(/0+$/, '');
  const text = fraction ? `${integerPart}.${fraction}` : integerPart.toString();
  return negative ? `-${text}` : text;
}

/** Converts to a JS number. For display and metrics only, never for arithmetic. */
export function toNumber(value: bigint): number {
  return Number(toDecimalString(value));
}

/**
 * Converts a float (e.g. the simulated market price) to a scaled BigInt,
 * rounded half-up to `decimals` places.
 */
export function fromNumber(value: number, decimals: number = SCALE): bigint {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`Cannot convert ${value} to a decimal amount`);
  }
  const parsed = parseDecimal(value.toFixed(Math.min(decimals, 20)), SCALE);
  if (parsed === null) throw new RangeError(`Cannot convert ${value} to a decimal amount`);
  return roundToDecimals(parsed, decimals, 'half-up');
}

/** Multiplies two scaled values, truncating toward zero. */
export function mul(a: bigint, b: bigint): bigint {
  return (a * b) / ONE;
}

/** Multiplies two non-negative scaled values, rounding up. Used for holds, which must never fall short. */
export function mulCeil(a: bigint, b: bigint): bigint {
  const product = a * b;
  return (product + ONE - 1n) / ONE;
}

/** Rounds a non-negative scaled value to `decimals` places. */
export function roundToDecimals(
  value: bigint,
  decimals: number,
  mode: 'down' | 'up' | 'half-up'
): bigint {
  if (decimals >= SCALE) return value;
  const unit = 10n ** BigInt(SCALE - decimals);
  const remainder = value % unit;
  if (remainder === 0n) return value;
  const floor = value - remainder;
  if (mode === 'down') return floor;
  if (mode === 'up') return floor + unit;
  return remainder * 2n >= unit ? floor + unit : floor;
}

export function minDecimal(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}
