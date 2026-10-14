import { deliveryTracker, ClaimedDelivery } from '../services/delivery.js';
import { calculateBackoff, isRetryableError, RetryableError } from '../utils/retry.js';
import { CircuitBreakerOpenError } from '../utils/circuitBreaker.js';
import { MessageOutcome, QueueMessage } from '../utils/rabbitmq.js';
import { createLogger } from '../utils/logger.js';
import {
  deliveryAttemptsCounter,
  deliveryOutcomesCounter,
  notificationsSentCounter,
  processingDurationHistogram,
} from '../utils/metrics.js';
import { Logger } from 'pino';

const log: Logger = createLogger('delivery-handler');

/** Provider attempts per delivery before it is marked failed and dead-lettered. */
export const MAX_ATTEMPTS = parseInt(process.env.DELIVERY_MAX_ATTEMPTS || '5');
const RETRY_BASE_MS = parseInt(process.env.DELIVERY_RETRY_BASE_MS || '5000');
/** Matches the breakers' half-open delay: no point asking again sooner. */
const CIRCUIT_OPEN_DELAY_MS = 30000;
export const LEASE_SECONDS = 60;

/** Failure reasons that no retry can fix. */
const PERMANENT_REASONS = new Set(['no_devices', 'no_email', 'no_phone', 'email_not_verified']);

export interface ProviderResult {
  success: boolean;
  retryable?: boolean;
  circuitOpen?: boolean;
  reason?: string;
  error?: string;
  [key: string]: unknown;
}

export type Provider = (delivery: ClaimedDelivery) => Promise<ProviderResult>;

/** Backoff before attempt `attempt + 1`: ~5 s, 10 s, 20 s, 40 s, capped at 5 min, 20% jitter. */
export function retryDelayMs(attempt: number): number {
  return calculateBackoff(Math.max(0, attempt - 1), {
    baseDelayMs: RETRY_BASE_MS,
    maxDelayMs: 300000,
    multiplier: 2,
    jitterFactor: 0.2,
  });
}

function isRetryableResult(result: ProviderResult): boolean {
  if (result.reason && PERMANENT_REASONS.has(result.reason)) return false;
  return result.retryable !== false;
}

/**
 * Handles one delivery message and tells the consumer what to do with it.
 *
 * 1. Claim the (notification, channel) row. No claim means the work is done,
 *    cancelled or owned by a live worker: ack and stop. This is what makes a
 *    redelivered or duplicated message unable to send twice.
 * 2. Call the provider with the claimed content (PostgreSQL, not the message).
 * 3. Success: mark sent. Circuit open: retry later without spending an attempt.
 *    Transient failure: schedule a durable retry through the outbox. Permanent
 *    failure: mark failed. Retry budget exhausted: mark failed and dead-letter.
 */
export async function processDelivery(
  message: QueueMessage,
  providers: Record<string, Provider>
): Promise<MessageOutcome> {
  const { notificationId, channel } = message;
  const provider = providers[channel];
  if (!provider) {
    log.error({ notificationId, channel }, 'Unknown channel; dead-lettering');
    deliveryOutcomesCounter.labels(channel, 'dead_lettered').inc();
    return 'dead-letter';
  }

  const delivery = await deliveryTracker.claim(notificationId, channel, LEASE_SECONDS);
  if (!delivery) {
    log.info({ notificationId, channel }, 'Nothing to deliver (done, cancelled or claimed elsewhere)');
    deliveryOutcomesCounter.labels(channel, 'skipped').inc();
    return 'ack';
  }

  const logContext = { notificationId, channel, priority: delivery.priority, attempt: delivery.attempt };
  const timer = processingDurationHistogram.labels(channel, delivery.priority).startTimer();
  const startedAt = Date.now();

  let result: ProviderResult;
  try {
    result = await provider(delivery);
  } catch (error) {
    result = {
      success: false,
      circuitOpen: error instanceof CircuitBreakerOpenError,
      retryable: isRetryableError(error as RetryableError),
      error: (error as Error).message,
    };
  }
  timer();

  const details = {
    ...result,
    attempt: delivery.attempt,
    processingTimeMs: Date.now() - startedAt,
    queuedAt: message.queuedAt,
  };
  deliveryAttemptsCounter.labels(channel, String(result.success)).inc();

  if (result.success) {
    const recorded = await deliveryTracker.complete(delivery, 'sent', { ...details, deliveredAt: Date.now() });
    deliveryOutcomesCounter.labels(channel, 'sent').inc();
    notificationsSentCounter.labels(channel, delivery.priority, 'sent').inc();
    log.info({ ...logContext, recorded }, 'Delivered');
    return 'ack';
  }

  if (result.circuitOpen) {
    await deliveryTracker.scheduleRetry(delivery, CIRCUIT_OPEN_DELAY_MS, details, false);
    deliveryOutcomesCounter.labels(channel, 'deferred').inc();
    log.warn(logContext, 'Provider circuit open; delivery deferred without spending an attempt');
    return 'ack';
  }

  const retryable = isRetryableResult(result);
  if (retryable && delivery.attempt < MAX_ATTEMPTS) {
    const delayMs = retryDelayMs(delivery.attempt);
    await deliveryTracker.scheduleRetry(delivery, delayMs, details, true);
    deliveryOutcomesCounter.labels(channel, 'retry_scheduled').inc();
    log.warn({ ...logContext, delayMs, error: result.error || result.reason }, 'Delivery failed; retry scheduled');
    return 'ack';
  }

  await deliveryTracker.complete(delivery, 'failed', { ...details, exhaustedRetries: retryable });
  notificationsSentCounter.labels(channel, delivery.priority, 'failed').inc();

  if (retryable) {
    // Budget exhausted on a transient error: keep a copy in the dead-letter
    // queue for replay once the provider recovers.
    deliveryOutcomesCounter.labels(channel, 'dead_lettered').inc();
    log.error({ ...logContext, error: result.error }, 'Retries exhausted; dead-lettering');
    return 'dead-letter';
  }

  deliveryOutcomesCounter.labels(channel, 'failed').inc();
  log.warn({ ...logContext, reason: result.reason }, 'Permanent delivery failure');
  return 'ack';
}
