import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({ publish: vi.fn() }));

vi.mock('../redis.js', () => ({ pubClient: { publish: mocks.publish } }));
vi.mock('../shared/logger.js', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { buildDeliveryReceipts, publishDeliveryReceipts, publishNewMessage } from './realtime.js';

const acked = [
  { message_id: 'm1', conversation_id: 'c1', seq: 4, sender_id: 'alice' },
  { message_id: 'm2', conversation_id: 'c1', seq: 6, sender_id: 'alice' },
  { message_id: 'm3', conversation_id: 'c1', seq: 5, sender_id: 'carol' },
  { message_id: 'm4', conversation_id: 'c2', seq: 9, sender_id: 'bob' },
];

describe('buildDeliveryReceipts', () => {
  it('groups acknowledged messages per conversation, addressed to their senders', () => {
    const events = buildDeliveryReceipts('dave', 'dave-phone', acked);

    expect(events).toEqual([
      {
        conversationId: 'c1',
        messageIds: ['m1', 'm2', 'm3'],
        seq: 6,
        userId: 'dave',
        deviceId: 'dave-phone',
        targetUserIds: ['alice', 'carol'],
      },
      {
        conversationId: 'c2',
        messageIds: ['m4'],
        seq: 9,
        userId: 'dave',
        deviceId: 'dave-phone',
        targetUserIds: ['bob'],
      },
    ]);
  });

  it("skips the user's own messages arriving on their other devices", () => {
    const events = buildDeliveryReceipts('bob', 'bob-ipad', acked);
    expect(events.map((e) => e.conversationId)).toEqual(['c1']);
  });
});

describe('publishing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('publishes one delivery event per conversation', async () => {
    mocks.publish.mockResolvedValue(1);
    await publishDeliveryReceipts('dave', 'dave-phone', acked);
    expect(mocks.publish).toHaveBeenCalledTimes(2);
    expect(mocks.publish.mock.calls[0][0]).toBe('delivery_receipts');
  });

  it('swallows publish failures: the inbox row, not pub/sub, is the delivery guarantee', async () => {
    mocks.publish.mockRejectedValue(new Error('redis down'));
    await expect(
      publishNewMessage({ message: { id: 'm1' } as never, participantIds: ['alice'] })
    ).resolves.toBeUndefined();
  });
});
