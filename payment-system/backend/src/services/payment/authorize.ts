/**
 * Payment authorization module.
 * Handles the creation and authorization of new payment transactions.
 *
 * Flow for POST /payments:
 * 1. Claim: insert the payment as 'pending' keyed by (merchant, Idempotency-Key).
 *    A duplicate request reads the existing row instead: same body -> replay,
 *    different body -> 422, still pending -> 409.
 * 2. Fraud score; a score above 90 fails the payment without calling out.
 * 3. Authorize with the processor using the payment id as its idempotency key.
 * 4. Apply the outcome with a guarded transition: approved -> authorized (and
 *    captured, with its ledger journal, in the same database transaction when
 *    auto-capture is on); declined or not attempted -> failed; unknown -> stays
 *    'pending' and the API answers 202 until the reconciler resolves it.
 */

import { pool, query, queryOne, withTransaction } from '../../db/connection.js';
import {
  logger,
  paymentTransactionsTotal,
  paymentProcessingDuration,
  paymentAmountHistogram,
  fraudScoreHistogram,
  fraudDecisionsTotal,
  idempotencyRequestsTotal,
  auditPaymentCreated,
  auditPaymentAuthorized,
  auditPaymentFailed,
} from '../../shared/index.js';
import { FraudService } from '../fraud.service.js';
import { calculateFee, requestFingerprint } from './validation.js';
import { authorizeWithProcessor } from './processor.js';
import { claimPaymentRecord, publishAsyncFraudCheck, generateTransactionId } from './transaction.js';
import { transitionStatus } from './state-machine.js';
import { captureInTransaction, afterCapture } from './capture.js';
import { idempotencyKeyReused, requestInProgress } from './errors.js';
import type { Transaction, CreatePaymentRequest, CreatePaymentResponse, ClientInfo } from './types.js';

const fraudService = new FraudService();

/** What the route sends back: status code, body, and whether it was a replay. */
export interface CreatePaymentResult {
  httpStatus: 200 | 201 | 202;
  replayed: boolean;
  body: CreatePaymentResponse;
}

/**
 * Creates a new payment, exactly once per (merchant, Idempotency-Key).
 */
export async function createPayment(
  merchantId: string,
  request: CreatePaymentRequest,
  clientInfo?: ClientInfo
): Promise<CreatePaymentResult> {
  const startTime = Date.now();
  const { feeAmount, netAmount } = calculateFee(request.amount);
  const requestHash = request.idempotency_key
    ? requestFingerprint(request as unknown as Record<string, unknown>)
    : null;

  const { claimed, transaction } = await claimPaymentRecord(
    generateTransactionId(), merchantId, request, requestHash, feeAmount, netAmount
  );

  if (!claimed) {
    return replayExisting(transaction, requestHash);
  }
  if (request.idempotency_key) {
    idempotencyRequestsTotal.labels('new').inc();
  }

  await auditPaymentCreated(
    transaction.id, merchantId, request.amount, request.currency,
    clientInfo?.ipAddress, clientInfo?.userAgent
  );

  const result = await processClaimedPayment(transaction, request, clientInfo);
  paymentProcessingDuration.labels('create', result.body.status).observe((Date.now() - startTime) / 1000);
  return result;
}

/**
 * A second request with a key that already has a payment. Replays return the
 * payment the key created, in its current state; they never run anything.
 */
function replayExisting(existing: Transaction, requestHash: string | null): CreatePaymentResult {
  if (existing.request_hash && existing.request_hash !== requestHash) {
    idempotencyRequestsTotal.labels('mismatch').inc();
    throw idempotencyKeyReused();
  }
  if (existing.status === 'pending') {
    idempotencyRequestsTotal.labels('in_progress').inc();
    throw requestInProgress(existing.id);
  }
  idempotencyRequestsTotal.labels('replay').inc();
  logger.info(
    { merchantId: existing.merchant_id, transactionId: existing.id },
    'Idempotent replay of payment creation'
  );
  return { httpStatus: 200, replayed: true, body: buildResponse(existing) };
}

/** Fraud check, processor call, and outcome handling for a freshly claimed payment. */
async function processClaimedPayment(
  transaction: Transaction,
  request: CreatePaymentRequest,
  clientInfo?: ClientInfo
): Promise<CreatePaymentResult> {
  const { amount, currency, payment_method, customer_email } = request;
  paymentAmountHistogram.labels(currency).observe(amount);

  const riskScore = await fraudService.evaluate({
    amount, currency, payment_method, merchantId: transaction.merchant_id, customerEmail: customer_email,
  });
  fraudScoreHistogram.labels(riskScore > 90 ? 'decline' : 'approve').observe(riskScore);

  if (riskScore > 90) {
    fraudDecisionsTotal.labels('decline').inc();
    const failed = await applyProcessorDecline(transaction.id, 'High fraud risk score', clientInfo, riskScore);
    return { httpStatus: 201, replayed: false, body: buildResponse(failed) };
  }
  fraudDecisionsTotal.labels('approve').inc();

  // Persist the score before calling out: if the outcome is unknown, the
  // reconciler finishes this payment without re-running the fraud check.
  await query('UPDATE transactions SET risk_score = $2 WHERE id = $1', [transaction.id, riskScore]);

  const outcome = await authorizeWithProcessor(transaction.id, amount, payment_method);

  switch (outcome.kind) {
    case 'approved': {
      const final = await applyProcessorApproval(transaction.id, outcome.processorRef, clientInfo);
      publishAsyncFraudCheck(
        transaction.id, transaction.merchant_id, amount, currency, payment_method,
        customer_email, clientInfo?.ipAddress
      );
      return { httpStatus: 201, replayed: false, body: buildResponse(final) };
    }
    case 'declined':
    case 'not_attempted': {
      const final = await applyProcessorDecline(transaction.id, outcome.reason, clientInfo);
      return { httpStatus: 201, replayed: false, body: buildResponse(final) };
    }
    case 'unknown': {
      paymentTransactionsTotal.labels('pending', currency).inc();
      logger.warn(
        { transactionId: transaction.id, reason: outcome.reason },
        'Authorization outcome unknown; returning 202 and leaving the payment to the reconciler'
      );
      return { httpStatus: 202, replayed: false, body: buildResponse(transaction) };
    }
  }
}

/**
 * Applies a processor approval: pending -> authorized, plus the capture and its
 * ledger journal in the same database transaction when auto-capture is on.
 * Used by the live request and by the reconciler; if the other one got there
 * first, the guarded transition matches nothing and the current row is returned.
 */
export async function applyProcessorApproval(
  transactionId: string,
  processorRef: string,
  clientInfo?: ClientInfo
): Promise<Transaction> {
  const applied = await withTransaction(async (client) => {
    const authorized = await transitionStatus(client, transactionId, ['pending'], 'authorized', {
      processor_ref: processorRef,
    });
    if (!authorized) return null;
    const captured = authorized.auto_capture ? await captureInTransaction(client, transactionId) : null;
    return { authorized, captured };
  });

  if (!applied) {
    return (await queryOne<Transaction>('SELECT * FROM transactions WHERE id = $1', [transactionId]))!;
  }

  const { authorized, captured } = applied;
  await auditPaymentAuthorized(
    authorized.id, authorized.merchant_id, processorRef, clientInfo?.ipAddress, clientInfo?.userAgent
  );
  paymentTransactionsTotal.labels('authorized', authorized.currency).inc();
  if (captured) {
    await afterCapture(captured, clientInfo);
    return captured;
  }
  return authorized;
}

/** Applies a decline (or a call that was never attempted): pending -> failed. */
export async function applyProcessorDecline(
  transactionId: string,
  reason: string,
  clientInfo?: ClientInfo,
  riskScore?: number
): Promise<Transaction> {
  const failed = await transitionStatus(
    pool, transactionId, ['pending'], 'failed', riskScore === undefined ? {} : { risk_score: riskScore }
  );
  if (!failed) {
    return (await queryOne<Transaction>('SELECT * FROM transactions WHERE id = $1', [transactionId]))!;
  }
  await auditPaymentFailed(failed.id, failed.merchant_id, reason, clientInfo?.ipAddress, clientInfo?.userAgent);
  paymentTransactionsTotal.labels('failed', failed.currency).inc();
  return failed;
}

/** Builds the public representation returned by POST /payments. */
function buildResponse(transaction: Transaction): CreatePaymentResponse {
  return {
    id: transaction.id,
    status: transaction.status,
    amount: Number(transaction.amount),
    currency: transaction.currency,
    fee_amount: Number(transaction.fee_amount),
    net_amount: Number(transaction.net_amount),
    created_at: transaction.created_at,
  };
}
