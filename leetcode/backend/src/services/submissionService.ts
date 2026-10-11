import type { Pool } from 'pg';
import { hashCode, hashRequest } from '../shared/idempotency.js';
import { QUEUE_CHANNEL } from '../shared/judgeQueue.js';

export interface CreateSubmissionInput {
  userId: string;
  problemSlug: string;
  language: string;
  code: string;
  idempotencyKey: string | null;
}

export interface SubmissionRef {
  id: string;
  status: string;
}

export type CreateSubmissionResult =
  /** New submission; it is in the judge queue. */
  | { kind: 'created'; submission: SubmissionRef }
  /** Same Idempotency-Key and body as an earlier request: that submission is returned. */
  | { kind: 'replayed'; submission: SubmissionRef }
  /** Identical code for this problem is already queued or running: that submission is returned. */
  | { kind: 'duplicate'; submission: SubmissionRef }
  /** The Idempotency-Key was already used with a different body. */
  | { kind: 'key_reused' }
  | { kind: 'problem_not_found' };

/** Conflicting rows can finish between our INSERT and the lookup; a fresh attempt then succeeds. */
const MAX_INSERT_ATTEMPTS = 3;

/**
 * Creates a submission and enqueues it for judging in one transaction.
 *
 * The INSERT uses ON CONFLICT DO NOTHING against two unique indexes:
 * - (user_id, idempotency_key): a retried request finds the row its first attempt created;
 * - (user_id, problem_id, language, code_hash) WHERE status is pending or running: the same code
 *   cannot be judged twice at the same time.
 * Concurrent duplicates are serialized by the index itself (the second INSERT waits for the first
 * transaction, then sees the conflict), so there is no check-then-act window.
 *
 * pg_notify is part of the transaction: PostgreSQL delivers it only if the row commits, so an
 * idle worker never wakes up for a submission that does not exist.
 */
export async function createSubmission(db: Pool, input: CreateSubmissionInput): Promise<CreateSubmissionResult> {
  const codeHash = hashCode(input.code);
  const requestHash = hashRequest(input);
  const client = await db.connect();

  try {
    await client.query('BEGIN');

    const problem = await client.query<{ id: string }>('SELECT id FROM problems WHERE slug = $1', [input.problemSlug]);
    if (problem.rows.length === 0) {
      await client.query('ROLLBACK');
      return { kind: 'problem_not_found' };
    }
    const problemId = problem.rows[0].id;

    for (let attempt = 0; attempt < MAX_INSERT_ATTEMPTS; attempt++) {
      const inserted = await client.query<SubmissionRef>(
        `INSERT INTO submissions (user_id, problem_id, language, code, status, idempotency_key, request_hash, code_hash)
         VALUES ($1, $2, $3, $4, 'pending', $5, $6, $7)
         ON CONFLICT DO NOTHING
         RETURNING id, status`,
        [input.userId, problemId, input.language, input.code, input.idempotencyKey, requestHash, codeHash]
      );

      if (inserted.rows.length === 1) {
        const submission = inserted.rows[0];
        await client.query(
          `INSERT INTO user_problem_status (user_id, problem_id, status, attempts)
           VALUES ($1, $2, 'attempted', 1)
           ON CONFLICT (user_id, problem_id) DO UPDATE SET
             attempts = user_problem_status.attempts + 1,
             status = CASE WHEN user_problem_status.status = 'solved' THEN 'solved' ELSE 'attempted' END`,
          [input.userId, problemId]
        );
        await client.query('SELECT pg_notify($1, $2)', [QUEUE_CHANNEL, submission.id]);
        await client.query('COMMIT');
        return { kind: 'created', submission };
      }

      // Nothing was inserted: find out which rule the request ran into.
      if (input.idempotencyKey !== null) {
        const byKey = await client.query<SubmissionRef & { request_hash: string | null }>(
          'SELECT id, status, request_hash FROM submissions WHERE user_id = $1 AND idempotency_key = $2',
          [input.userId, input.idempotencyKey]
        );
        if (byKey.rows.length === 1) {
          await client.query('ROLLBACK');
          const { id, status, request_hash: storedHash } = byKey.rows[0];
          return storedHash === requestHash
            ? { kind: 'replayed', submission: { id, status } }
            : { kind: 'key_reused' };
        }
      }

      const inFlight = await client.query<SubmissionRef>(
        `SELECT id, status FROM submissions
         WHERE user_id = $1 AND problem_id = $2 AND language = $3 AND code_hash = $4
           AND status IN ('pending', 'running')
         LIMIT 1`,
        [input.userId, problemId, input.language, codeHash]
      );
      if (inFlight.rows.length === 1) {
        await client.query('ROLLBACK');
        return { kind: 'duplicate', submission: inFlight.rows[0] };
      }
      // The conflicting submission finished in the meantime; try the INSERT again.
    }

    throw new Error('Could not create the submission after repeated conflicts');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
