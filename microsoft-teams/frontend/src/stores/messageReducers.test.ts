import { describe, expect, it } from 'vitest';
import type { Message } from '../types';
import { applyChannelEvent, applyReaction, mergeOlder, upsertMessage } from './messageReducers';

function msg(seq: number, extra: Partial<Message> = {}): Message {
  return {
    id: `m${seq}`,
    channel_id: 'c1',
    user_id: 'u1',
    parent_message_id: null,
    content: `message ${seq}`,
    is_edited: false,
    seq,
    created_at: '2026-10-10T00:00:00Z',
    updated_at: '2026-10-10T00:00:00Z',
    username: 'alice',
    display_name: 'Alice',
    reply_count: 0,
    reactions: [],
    ...extra,
  };
}

describe('upsertMessage', () => {
  it('replaces the optimistic copy in place when the server copy arrives', () => {
    const pending = msg(0, { id: 'pending-k1', client_message_id: 'k1', status: 'pending' });
    const list = upsertMessage([msg(1)], pending);
    const confirmed = upsertMessage(list, msg(2, { id: 'm2', client_message_id: 'k1' }));
    expect(confirmed.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(confirmed[1].status).toBeUndefined();
  });

  it('ignores the second copy of a message (REST response and stream event)', () => {
    const list = [msg(1), msg(2, { reactions: [{ emoji: '🎉', count: 1, users: ['bob'] }] })];
    expect(upsertMessage(list, msg(2))).toBe(list);
  });

  it('keeps confirmed messages in seq order with unsent ones last', () => {
    const pending = msg(0, { id: 'pending-k', client_message_id: 'k', status: 'failed' });
    const list = upsertMessage(upsertMessage([msg(3), pending], msg(5)), msg(4));
    expect(list.map((m) => m.id)).toEqual(['m3', 'm4', 'm5', 'pending-k']);
  });

  it('prepends older pages without duplicates', () => {
    expect(mergeOlder([msg(3), msg(4)], [msg(1), msg(2), msg(3)]).map((m) => m.seq)).toEqual([
      1, 2, 3, 4,
    ]);
  });
});

describe('applyChannelEvent', () => {
  const state = (messages: Message[], threadParentId: string | null = null) => ({
    messages,
    threadMessages: threadParentId ? messages.filter((m) => m.id === threadParentId) : [],
    threadParentId,
  });

  it('counts a reply on its root and shows it in the open thread, not the channel', () => {
    const next = applyChannelEvent(state([msg(1)], 'm1'), 'new_message', {
      ...msg(2, { parent_message_id: 'm1' }),
    });
    expect(next.messages?.map((m) => [m.id, m.reply_count])).toEqual([['m1', 1]]);
    expect(next.threadMessages?.map((m) => m.id)).toEqual(['m1', 'm2']);
  });

  it('turns a deleted reply into a tombstone and decrements its root', () => {
    const root = msg(1, { reply_count: 2 });
    const next = applyChannelEvent(state([root]), 'message_deleted', {
      id: 'm9',
      parent_message_id: 'm1',
      deleted_at: '2026-10-10T01:00:00Z',
    });
    expect(next.messages?.[0].reply_count).toBe(1);
  });

  it('applies reactions as a set, so a repeated event cannot double count', () => {
    const once = applyReaction(msg(1), '🔥', 'bob', true);
    const twice = applyReaction(once, '🔥', 'bob', true);
    expect(twice.reactions).toEqual([{ emoji: '🔥', count: 1, users: ['bob'] }]);
    expect(applyReaction(twice, '🔥', 'bob', false).reactions).toEqual([]);
  });
});
