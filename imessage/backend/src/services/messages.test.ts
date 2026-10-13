import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock shared modules before importing the service
const mocks = vi.hoisted(() => ({
  client: { query: vi.fn(), release: vi.fn() },
  query: vi.fn(),
}));

vi.mock('../db.js', () => ({
  query: mocks.query,
  getClient: vi.fn(async () => mocks.client),
  transaction: vi.fn(),
}));

vi.mock('../shared/logger.js', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import {
  sendMessage,
  acknowledgeDelivery,
  markAsRead,
  NotParticipantError,
  IdempotencyConflictError,
} from './messages.js';

const CONVERSATION = 'c0000000-0000-0000-0000-000000000001';
const ALICE = 'a0000000-0000-0000-0000-000000000001';
const ALICE_PHONE = 'd0000000-0000-0000-0000-000000000001';

/** Scripts the transaction client: each call returns the next result, matched by SQL. */
function scriptClient(responses: Array<{ match: string; result: object } | { match: string; error: Error }>) {
  mocks.client.query.mockImplementation(async (sql: string) => {
    const next = responses.shift();
    if (!next) throw new Error(`Unexpected query: ${sql}`);
    if (!sql.includes(next.match)) {
      throw new Error(`Expected query containing "${next.match}", got: ${sql.slice(0, 80)}`);
    }
    if ('error' in next) throw next.error;
    return next.result;
  });
}

const sqlCalls = () => mocks.client.query.mock.calls.map(([sql]) => String(sql).trim().split(/\s+/).slice(0, 3).join(' '));

describe('sendMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('assigns the next conversation seq and queues the message for recipient devices in one transaction', async () => {
    scriptClient([
      { match: 'BEGIN', result: {} },
      { match: 'UPDATE conversations', result: { rowCount: 1, rows: [{ last_seq: 7 }] } },
      {
        match: 'INSERT INTO messages',
        result: { rowCount: 1, rows: [{ id: 'm-7', conversation_id: CONVERSATION, seq: 7, content: 'hi' }] },
      },
      { match: 'INSERT INTO device_inbox', result: { rows: [{ participant_ids: [ALICE, 'bob'], inbox_rows: 3 }] } },
      { match: 'COMMIT', result: {} },
    ]);

    const result = await sendMessage({
      conversationId: CONVERSATION,
      senderId: ALICE,
      senderDeviceId: ALICE_PHONE,
      content: 'hi',
      clientMessageId: 'client-1',
    });

    expect(result.isDuplicate).toBe(false);
    expect(result.message.seq).toBe(7);
    expect(result.participantIds).toEqual([ALICE, 'bob']);
    expect(result.inboxRowCount).toBe(3);

    // The insert carries the seq taken under the row lock and the client ID
    const insertParams = mocks.client.query.mock.calls[2][1];
    expect(insertParams).toEqual([CONVERSATION, ALICE, 7, 'client-1', 'hi', 'text', null]);

    // The sending device is excluded from the inbox fan-out
    const fanoutParams = mocks.client.query.mock.calls[3][1];
    expect(fanoutParams).toEqual(['m-7', CONVERSATION, 7, ALICE_PHONE]);

    expect(sqlCalls().at(-1)).toBe('COMMIT');
    expect(mocks.client.release).toHaveBeenCalledOnce();
  });

  it('returns the original message for a retried clientMessageId and gives the seq back', async () => {
    scriptClient([
      { match: 'BEGIN', result: {} },
      { match: 'UPDATE conversations', result: { rowCount: 1, rows: [{ last_seq: 8 }] } },
      { match: 'INSERT INTO messages', result: { rowCount: 0, rows: [] } },
      { match: 'ROLLBACK', result: {} },
      {
        match: 'client_message_id = $3',
        result: { rowCount: 1, rows: [{ id: 'm-7', conversation_id: CONVERSATION, seq: 7, content: 'hi' }] },
      },
    ]);

    const result = await sendMessage({
      conversationId: CONVERSATION,
      senderId: ALICE,
      senderDeviceId: ALICE_PHONE,
      content: 'hi',
      clientMessageId: 'client-1',
    });

    expect(result.isDuplicate).toBe(true);
    expect(result.message.id).toBe('m-7');
    expect(result.message.seq).toBe(7);
    expect(result.participantIds).toEqual([]);
    // No second inbox fan-out and no COMMIT of the burned seq
    expect(sqlCalls().some((sql) => sql.includes('device_inbox'))).toBe(false);
    expect(sqlCalls()).not.toContain('COMMIT');
    expect(mocks.client.release).toHaveBeenCalledOnce();
  });

  it('rejects a reused clientMessageId that carries different content', async () => {
    scriptClient([
      { match: 'BEGIN', result: {} },
      { match: 'UPDATE conversations', result: { rowCount: 1, rows: [{ last_seq: 8 }] } },
      { match: 'INSERT INTO messages', result: { rowCount: 0, rows: [] } },
      { match: 'ROLLBACK', result: {} },
      {
        match: 'client_message_id = $3',
        result: { rowCount: 1, rows: [{ id: 'm-7', conversation_id: CONVERSATION, seq: 7, content: 'hi' }] },
      },
    ]);

    await expect(
      sendMessage({
        conversationId: CONVERSATION,
        senderId: ALICE,
        senderDeviceId: ALICE_PHONE,
        content: 'something else',
        clientMessageId: 'client-1',
      })
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it('refuses senders who are not active participants, inside the same statement that takes the seq', async () => {
    scriptClient([
      { match: 'BEGIN', result: {} },
      { match: 'UPDATE conversations', result: { rowCount: 0, rows: [] } },
      { match: 'ROLLBACK', result: {} },
    ]);

    await expect(
      sendMessage({ conversationId: CONVERSATION, senderId: 'stranger', senderDeviceId: null, content: 'hi' })
    ).rejects.toBeInstanceOf(NotParticipantError);

    expect(sqlCalls().some((sql) => sql.includes('INSERT'))).toBe(false);
    expect(mocks.client.release).toHaveBeenCalledOnce();
  });

  it('rolls back and releases the client when the fan-out fails', async () => {
    scriptClient([
      { match: 'BEGIN', result: {} },
      { match: 'UPDATE conversations', result: { rowCount: 1, rows: [{ last_seq: 3 }] } },
      { match: 'INSERT INTO messages', result: { rowCount: 1, rows: [{ id: 'm-3', seq: 3 }] } },
      { match: 'INSERT INTO device_inbox', error: new Error('connection reset') },
      { match: 'ROLLBACK', result: {} },
    ]);

    await expect(
      sendMessage({ conversationId: CONVERSATION, senderId: ALICE, senderDeviceId: ALICE_PHONE, content: 'hi' })
    ).rejects.toThrow('connection reset');

    expect(sqlCalls().at(-1)).toBe('ROLLBACK');
    expect(mocks.client.release).toHaveBeenCalledOnce();
  });
});

describe('acknowledgeDelivery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does nothing for an empty ack', async () => {
    expect(await acknowledgeDelivery(ALICE_PHONE, [])).toEqual([]);
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('deletes inbox rows and records receipts in one statement, returning only rows that were pending', async () => {
    mocks.query.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ message_id: 'm-1', conversation_id: CONVERSATION, seq: 4, sender_id: 'bob' }],
    });

    const acked = await acknowledgeDelivery(ALICE_PHONE, ['m-1', 'm-already-acked']);

    expect(acked).toHaveLength(1);
    const [sql, params] = mocks.query.mock.calls[0];
    expect(sql).toContain('DELETE FROM device_inbox');
    expect(sql).toContain('INSERT INTO delivery_receipts');
    expect(params).toEqual([ALICE_PHONE, ['m-1', 'm-already-acked']]);
  });
});

describe('markAsRead', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects a message that is not in the conversation', async () => {
    mocks.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    expect(await markAsRead(CONVERSATION, ALICE, ALICE_PHONE, 'm-elsewhere')).toBeNull();
    expect(mocks.query).toHaveBeenCalledTimes(1);
  });

  it('only moves the watermark forward', async () => {
    mocks.query
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 'm-2', seq: 2 }] })
      // ON CONFLICT ... WHERE last_read_seq < EXCLUDED.last_read_seq matched nothing
      .mockResolvedValueOnce({ rowCount: 0, rows: [] });

    const result = await markAsRead(CONVERSATION, ALICE, ALICE_PHONE, 'm-2');

    expect(result).toEqual({ seq: 2, messageId: 'm-2', advanced: false });
    expect(mocks.query.mock.calls[1][0]).toContain('WHERE read_receipts.last_read_seq < EXCLUDED.last_read_seq');
  });
});
