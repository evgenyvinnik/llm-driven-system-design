/**
 * Payment processor (PSP) integration module.
 *
 * Two rules make calls to an external processor safe:
 *
 * 1. Every authorization carries OUR reference (the transaction id) as the
 *    processor's idempotency key. Sending the same reference twice can never
 *    create a second authorization, so a retry is safe only if it reuses the
 *    reference. That is the difference between a retry and a blind retry.
 *
 * 2. A call has four possible outcomes, not two. "Declined" and "approved" are
 *    answers. "Not attempted" (circuit open, request never left this process)
 *    is safe to report as a failure. "Unknown" (timeout or connection reset
 *    after the request was sent) is NOT a failure: the processor may have
 *    approved it. Unknown payments stay `pending` until the reconciler asks the
 *    processor what happened (see reconcile.ts).
 *
 * The processor itself is simulated. It keeps its own records in Redis under
 * `psp-sim:*`, separate from our PostgreSQL, the way a real processor's
 * database is separate from ours. Test cards:
 *   last_four '0000' -> declined
 *   last_four '0001' -> approved at the processor, but the response is lost (timeout)
 *   last_four '0002' -> the first attempt is lost before the processor records it
 */

import { v4 as uuidv4 } from 'uuid';
import { BrokenCircuitError } from 'cockatiel';
import { redis } from '../../db/connection.js';
import { logger, processorCircuitBreaker } from '../../shared/index.js';
import type { CreatePaymentRequest } from './types.js';

/** Outcome of an authorization attempt. */
export type ProcessorOutcome =
  | { kind: 'approved'; processorRef: string }
  | { kind: 'declined'; reason: string }
  | { kind: 'not_attempted'; reason: string }
  | { kind: 'unknown'; reason: string };

/** What the processor says about a reference when asked after the fact. */
export type ProcessorLookup =
  | { status: 'approved'; processorRef: string }
  | { status: 'declined'; reason: string }
  | { status: 'not_found' };

interface SimulatedRecord {
  status: 'approved' | 'declined';
  processorRef?: string;
  reason?: string;
  amount: number;
}

/** Raised when the processor does not answer in time. */
export class ProcessorTimeoutError extends Error {
  constructor(message = 'Processor did not respond in time') {
    super(message);
    this.name = 'ProcessorTimeoutError';
  }
}

const RECORD_TTL_SECONDS = 7 * 24 * 3600;
const PROCESSOR_TIMEOUT_MS = parseInt(process.env.PSP_TIMEOUT_MS || '5000', 10);
const DECLINE_RATE = parseFloat(process.env.PSP_DECLINE_RATE || '0.05');

const recordKey = (reference: string) => `psp-sim:payment:${reference}`;

/**
 * Authorizes a payment with the processor, through the circuit breaker and a
 * timeout. Never throws: every failure is classified into an outcome.
 *
 * @param reference - Our transaction id, used as the processor idempotency key
 */
export async function authorizeWithProcessor(
  reference: string,
  amount: number,
  paymentMethod: CreatePaymentRequest['payment_method']
): Promise<ProcessorOutcome> {
  try {
    const record = await processorCircuitBreaker.policy.execute(() =>
      withTimeout(simulateProcessorAuthorize(reference, amount, paymentMethod), PROCESSOR_TIMEOUT_MS)
    );

    if (record.status === 'approved' && record.processorRef) {
      return { kind: 'approved', processorRef: record.processorRef };
    }
    return { kind: 'declined', reason: record.reason || 'Processor declined' };
  } catch (error) {
    if (error instanceof BrokenCircuitError) {
      logger.warn({ reference, amount }, 'Processor circuit open; authorization not attempted');
      return { kind: 'not_attempted', reason: 'Processor unavailable' };
    }
    logger.error(
      { error, reference, amount },
      'Processor authorization outcome unknown; payment left pending for reconciliation'
    );
    return { kind: 'unknown', reason: error instanceof Error ? error.message : 'Unknown processor error' };
  }
}

/**
 * Asks the processor what happened to a reference. Used by the reconciler to
 * resolve payments whose authorization outcome is unknown.
 */
export async function lookupProcessorPayment(reference: string): Promise<ProcessorLookup> {
  const raw = await redis.get(recordKey(reference));
  if (!raw) return { status: 'not_found' };
  const record = JSON.parse(raw) as SimulatedRecord;
  if (record.status === 'approved' && record.processorRef) {
    return { status: 'approved', processorRef: record.processorRef };
  }
  return { status: 'declined', reason: record.reason || 'Processor declined' };
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ProcessorTimeoutError()), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * The simulated processor. Idempotent per reference: the first decision is
 * stored with SET NX, and any later call with the same reference gets that
 * decision back instead of a new authorization.
 */
async function simulateProcessorAuthorize(
  reference: string,
  amount: number,
  paymentMethod: CreatePaymentRequest['payment_method']
): Promise<SimulatedRecord> {
  await new Promise((resolve) => setTimeout(resolve, 100));

  const existing = await redis.get(recordKey(reference));
  if (existing) {
    return JSON.parse(existing) as SimulatedRecord;
  }

  // Test card: the request is lost in transit the first time this reference is
  // sent, so the processor has no record of it.
  if (paymentMethod.last_four === '0002') {
    const firstAttempt = await redis.set(`psp-sim:lost:${reference}`, '1', 'EX', RECORD_TTL_SECONDS, 'NX');
    if (firstAttempt) {
      throw new ProcessorTimeoutError('Connection reset before the processor received the request');
    }
  }

  let decision: SimulatedRecord;
  if (paymentMethod.last_four === '0000') {
    decision = { status: 'declined', reason: 'Card declined', amount };
  } else if (Math.random() < (amount > 1000000 ? Math.max(DECLINE_RATE, 0.3) : DECLINE_RATE)) {
    decision = { status: 'declined', reason: 'Processor declined', amount };
  } else {
    decision = { status: 'approved', processorRef: `proc_${uuidv4().slice(0, 8)}`, amount };
  }

  const stored = await redis.set(recordKey(reference), JSON.stringify(decision), 'EX', RECORD_TTL_SECONDS, 'NX');
  if (!stored) {
    // A concurrent call with the same reference decided first; honor it.
    const winner = await redis.get(recordKey(reference));
    if (winner) decision = JSON.parse(winner) as SimulatedRecord;
  }

  // Test card: the processor approved and recorded it, but the response is lost.
  if (paymentMethod.last_four === '0001') {
    throw new ProcessorTimeoutError();
  }

  return decision;
}
