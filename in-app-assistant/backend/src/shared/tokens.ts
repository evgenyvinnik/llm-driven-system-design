/**
 * Token estimates. Close enough for budgets and context trimming; real usage
 * numbers come back from the model on every call.
 * @module shared/tokens
 */
export function estimateTokens(value: unknown): number {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '')
  return Math.ceil(text.length / 4)
}
