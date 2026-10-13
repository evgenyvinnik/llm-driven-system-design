import { describe, it, expect, vi } from 'vitest';
import type { Pool } from 'pg';
import { createSubmission, type CreateSubmissionInput } from './submissionService.js';
import { hashRequest } from '../shared/idempotency.js';

type Rows = Array<Record<string, unknown>>;

/** A pool whose single client answers each statement by the first matching SQL fragment. */
function fakePool(answers: Array<[fragment: string, rows: Rows]>) {
  const statements: string[] = [];
  const client = {
    query: vi.fn(async (sql: string) => {
      statements.push(sql.trim().split(/\s+/).slice(0, 3).join(' '));
      const match = answers.find(([fragment]) => sql.includes(fragment));
      const rows = match ? match[1] : [];
      return { rows, rowCount: rows.length };
    }),
    release: vi.fn(),
  };
  return { pool: { connect: vi.fn().mockResolvedValue(client) } as unknown as Pool, client, statements };
}

const input: CreateSubmissionInput = {
  userId: 'user-1',
  problemSlug: 'two-sum',
  language: 'python',
  code: 'print([0, 1])',
  idempotencyKey: 'key-1',
};

const PROBLEM: [string, Rows] = ['FROM problems', [{ id: 'problem-1' }]];

describe('createSubmission', () => {
  it('inserts, counts the attempt and notifies workers in one transaction', async () => {
    const { pool, client, statements } = fakePool([PROBLEM, ['INSERT INTO submissions', [{ id: 'sub-1', status: 'pending' }]]]);

    const result = await createSubmission(pool, input);

    expect(result).toEqual({ kind: 'created', submission: { id: 'sub-1', status: 'pending' } });
    expect(statements[0]).toBe('BEGIN');
    expect(statements.at(-1)).toBe('COMMIT');
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining('user_problem_status'), ['user-1', 'problem-1']);
    expect(client.query).toHaveBeenCalledWith('SELECT pg_notify($1, $2)', ['judge_queue', 'sub-1']);
    expect(client.release).toHaveBeenCalled();
  });

  it('replays the original submission for a repeated Idempotency-Key with the same body', async () => {
    const { pool, statements } = fakePool([
      PROBLEM,
      ['idempotency_key = $2', [{ id: 'sub-1', status: 'running', request_hash: hashRequest(input) }]],
    ]);

    const result = await createSubmission(pool, input);

    expect(result).toEqual({ kind: 'replayed', submission: { id: 'sub-1', status: 'running' } });
    expect(statements).toContain('ROLLBACK');
    expect(statements).not.toContain('COMMIT');
  });

  it('rejects an Idempotency-Key reused for different code', async () => {
    const { pool } = fakePool([
      PROBLEM,
      ['idempotency_key = $2', [{ id: 'sub-1', status: 'accepted', request_hash: hashRequest({ ...input, code: 'print(1)' }) }]],
    ]);

    expect(await createSubmission(pool, input)).toEqual({ kind: 'key_reused' });
  });

  it('returns the in-flight submission when identical code is already queued', async () => {
    const { pool } = fakePool([PROBLEM, ["status IN ('pending', 'running')", [{ id: 'sub-0', status: 'pending' }]]]);

    const result = await createSubmission(pool, { ...input, idempotencyKey: null });

    expect(result).toEqual({ kind: 'duplicate', submission: { id: 'sub-0', status: 'pending' } });
  });

  it('retries the insert when the conflicting submission finished meanwhile, then gives up', async () => {
    const { pool, client } = fakePool([PROBLEM]);

    await expect(createSubmission(pool, { ...input, idempotencyKey: null })).rejects.toThrow('repeated conflicts');
    const inserts = client.query.mock.calls.filter(([sql]) => String(sql).includes('INSERT INTO submissions'));
    expect(inserts).toHaveLength(3);
  });

  it('reports an unknown problem', async () => {
    const { pool } = fakePool([]);
    expect(await createSubmission(pool, input)).toEqual({ kind: 'problem_not_found' });
  });
});
