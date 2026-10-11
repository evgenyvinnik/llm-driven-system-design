/**
 * Output checker: decides whether a program's stdout matches a test case's expected output.
 *
 * A judge must ignore formatting noise (trailing spaces, CRLF line endings, a missing final
 * newline) without becoming lenient enough to accept wrong answers. The rules:
 *
 * - Outputs are compared token by token, so "1 2 4" never matches "1 2 3" and extra debug
 *   lines after the answer are a mismatch.
 * - A numeric token is compared with a tolerance only when one side is a decimal ("2.5",
 *   "2.0"), and the whole token must be a number: "89abc" is not 89.
 * - JSON arrays and objects are compared structurally, so "[0, 1]" (Python's json.dumps)
 *   matches "[0,1]".
 * - Element order is ignored only for problems whose checker is 'unordered' (Two Sum:
 *   "return the answer in any order"), never globally.
 */

/** Per-problem comparison mode, stored in problems.checker. */
export type CheckerMode = 'exact' | 'unordered';

export const CHECKER_MODES: readonly CheckerMode[] = ['exact', 'unordered'];

const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const TOLERANCE = 1e-6;

/** Normalizes line endings and strips trailing whitespace on every line and around the output. */
export function normalizeOutput(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .join('\n')
    .trim();
}

function isDecimal(token: string): boolean {
  return /[.eE]/.test(token);
}

function numbersClose(actual: number, expected: number): boolean {
  return Math.abs(actual - expected) <= TOLERANCE * Math.max(1, Math.abs(expected));
}

function tokenMatches(actual: string, expected: string): boolean {
  if (actual === expected) return true;
  if (!NUMBER.test(actual) || !NUMBER.test(expected)) return false;
  // Two integers must be identical; a decimal on either side allows a small tolerance.
  if (!isDecimal(actual) && !isDecimal(expected)) return false;
  return numbersClose(Number(actual), Number(expected));
}

function tokensMatch(actual: string, expected: string): boolean {
  const actualTokens = actual.split(/\s+/).filter(Boolean);
  const expectedTokens = expected.split(/\s+/).filter(Boolean);
  if (actualTokens.length !== expectedTokens.length) return false;
  return expectedTokens.every((token, i) => tokenMatches(actualTokens[i], token));
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Canonical string for sorting JSON values, with object keys in a stable order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function jsonEqual(actual: unknown, expected: unknown, unorderedTopLevel: boolean): boolean {
  if (typeof actual === 'number' && typeof expected === 'number') {
    if (actual === expected) return true;
    const decimal = !Number.isInteger(actual) || !Number.isInteger(expected);
    return decimal && numbersClose(actual, expected);
  }
  if (Array.isArray(actual) && Array.isArray(expected)) {
    if (actual.length !== expected.length) return false;
    if (unorderedTopLevel) {
      const sortedActual = [...actual].sort((a, b) => canonical(a).localeCompare(canonical(b)));
      const sortedExpected = [...expected].sort((a, b) => canonical(a).localeCompare(canonical(b)));
      return sortedExpected.every((value, i) => jsonEqual(sortedActual[i], value, false));
    }
    return expected.every((value, i) => jsonEqual(actual[i], value, false));
  }
  if (isPlainObject(actual) && isPlainObject(expected)) {
    const keys = Object.keys(expected);
    if (Object.keys(actual).length !== keys.length) return false;
    return keys.every((key) => key in actual && jsonEqual(actual[key], expected[key], false));
  }
  return actual === expected;
}

/** Returns true when `actual` is an accepted answer for `expected` under the problem's checker. */
export function compareOutput(actual: string, expected: string, mode: CheckerMode = 'exact'): boolean {
  const actualNorm = normalizeOutput(actual);
  const expectedNorm = normalizeOutput(expected);
  if (actualNorm === expectedNorm) return true;

  // Structured answers (arrays, objects) compare by value, not by spacing.
  const expectedJson = parseJson(expectedNorm);
  if (expectedJson.ok && typeof expectedJson.value === 'object' && expectedJson.value !== null) {
    const actualJson = parseJson(actualNorm);
    return actualJson.ok && jsonEqual(actualJson.value, expectedJson.value, mode === 'unordered');
  }

  return tokensMatch(actualNorm, expectedNorm);
}
