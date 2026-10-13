import { describe, it, expect } from 'vitest';
import type { Message } from '@/types';
import {
  upsertMessage,
  mergeMessages,
  markDelivered,
  markReadUpTo,
  highestSeq,
  hasGap,
  laterStatus,
} from './messageList';

const ME = 'alice';

function msg(overrides: Partial<Message>): Message {
  return {
    id: 'id',
    conversation_id: 'c1',
    sender_id: 'bob',
    content: 'hello',
    content_type: 'text',
    reply_to_id: null,
    edited_at: null,
    created_at: '2026-10-10T12:00:00.000Z',
    sender_username: 'bob',
    sender_display_name: 'Bob',
    sender_avatar_url: null,
    reactions: null,
    reply_to: null,
    ...overrides,
  };
}

describe('upsertMessage', () => {
  it('orders by seq regardless of arrival order', () => {
    let list: Message[] = [];
    list = upsertMessage(list, msg({ id: 'm3', seq: 3 }));
    list = upsertMessage(list, msg({ id: 'm1', seq: 1 }));
    list = upsertMessage(list, msg({ id: 'm2', seq: 2 }));
    expect(list.map((m) => m.seq)).toEqual([1, 2, 3]);
  });

  it('applies the same message twice as one (live push, then sync batch)', () => {
    const live = upsertMessage([], msg({ id: 'm1', seq: 1 }));
    const afterSync = mergeMessages(live, [msg({ id: 'm1', seq: 1 }), msg({ id: 'm2', seq: 2 })]);
    expect(afterSync.map((m) => m.id)).toEqual(['m1', 'm2']);
  });

  it("replaces the optimistic bubble with the server's ack instead of adding a second one", () => {
    const optimistic = msg({
      id: 'client-1',
      clientMessageId: 'client-1',
      sender_id: ME,
      status: 'sending',
      created_at: '2026-10-10T12:00:05.000Z',
    });
    const list = upsertMessage([msg({ id: 'm1', seq: 1 })], optimistic);
    expect(list[list.length - 1].id).toBe('client-1'); // pending messages stay last

    const acked = upsertMessage(list, msg({ id: 'm2', seq: 2, sender_id: ME, client_message_id: 'client-1', status: 'sent' }));
    expect(acked).toHaveLength(2);
    expect(acked[1]).toMatchObject({ id: 'm2', seq: 2, status: 'sent', clientMessageId: 'client-1' });
  });

  it('removes a message that arrives as a tombstone', () => {
    const list = upsertMessage([msg({ id: 'm1', seq: 1 })], msg({ id: 'm1', seq: 1, deleted_at: '2026-10-10T12:01:00Z' }));
    expect(list).toEqual([]);
  });

  it('never moves a status backwards', () => {
    const read = upsertMessage([], msg({ id: 'm1', seq: 1, sender_id: ME, status: 'read' }));
    const lateSent = upsertMessage(read, msg({ id: 'm1', seq: 1, sender_id: ME, status: 'sent' }));
    expect(lateSent[0].status).toBe('read');
    expect(laterStatus('delivered', 'read')).toBe('read');
    expect(laterStatus('read', 'delivered')).toBe('read');
  });
});

describe('receipts', () => {
  const list = [
    msg({ id: 'm1', seq: 1, sender_id: ME, status: 'sent' }),
    msg({ id: 'm2', seq: 2, sender_id: 'bob' }),
    msg({ id: 'm3', seq: 3, sender_id: ME, status: 'sent' }),
  ];

  it('marks only my own messages as delivered', () => {
    const next = markDelivered(list, ['m1', 'm2'], ME);
    expect(next.map((m) => m.status)).toEqual(['delivered', undefined, 'sent']);
  });

  it('marks my messages at or below the read watermark as read', () => {
    const next = markReadUpTo(list, 2, ME);
    expect(next.map((m) => m.status)).toEqual(['read', undefined, 'sent']);
  });

  it('returns the same array when nothing changes (no needless re-render)', () => {
    expect(markReadUpTo(list, 0, ME)).toBe(list);
  });
});

describe('gap detection', () => {
  it('flags a live message that skips a seq', () => {
    const list = [msg({ id: 'm1', seq: 1 }), msg({ id: 'm2', seq: 2 })];
    expect(highestSeq(list)).toBe(2);
    expect(hasGap(highestSeq(list), 3)).toBe(false);
    expect(hasGap(highestSeq(list), 5)).toBe(true);
  });

  it('has nothing to compare against before any message is known', () => {
    expect(hasGap(0, 42)).toBe(false);
  });
});
