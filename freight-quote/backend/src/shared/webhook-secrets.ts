/**
 * Development webhook secrets, one per customer. The seed stores them on the
 * customer row; the mock receiver uses the same function to verify. Production
 * generates a random secret per endpoint and shows it to the customer once.
 * @module shared/webhook-secrets
 */
import { createHash } from 'node:crypto'

export function webhookSecretFor(customerId: string): string {
  const seed = process.env.WEBHOOK_SECRET_SEED || 'freight-quote-dev'
  return `whsec_${createHash('sha256').update(`${seed}:${customerId}`).digest('hex').slice(0, 32)}`
}
