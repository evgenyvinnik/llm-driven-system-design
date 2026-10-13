import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';
import type { ChannelEvent } from './channelEvents.js';

// In-memory stand-in for the channel_events table and channels.last_seq.
const log = new Map<string, ChannelEvent[]>();
const head = (channelId: string) => Math.max(0, ...(log.get(channelId) ?? []).map((e) => e.seq));

vi.mock('./channelEvents.js', () => ({
  getChannelHead: vi.fn(async (channelId: string) => head(channelId)),
  getChannelHeads: vi.fn(async (ids: string[]) => new Map(ids.map((id) => [id, head(id)]))),
  readChannelEvents: vi.fn(async (channelId: string, after: number, upto: number) =>
    (log.get(channelId) ?? []).filter((e) => e.seq > after && e.seq <= upto),
  ),
}));
vi.mock('./pubsub.js', () => ({
  subscribeToChannel: vi.fn().mockResolvedValue(undefined),
  unsubscribeFromChannel: vi.fn().mockResolvedValue(undefined),
  publishChannelEvent: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import * as pubsub from './pubsub.js';
import * as channelEvents from './channelEvents.js';
import {
  addClient,
  broadcastChannelEvent,
  checkHeads,
  closeAllStreams,
  deliverChannelEvent,
  getStreamStats,
  MAX_REPLAY_EVENTS,
} from './sseService.js';

/** A minimal SSE response: records frames, emits 'close' when ended. */
class FakeResponse extends EventEmitter {
  frames: string[] = [];
  writableLength = 0;
  write(frame: string) {
    this.frames.push(frame);
    return true;
  }
  end() {
    this.emit('close');
  }
  /** Event ids (seq) in the order they were written. */
  ids(): number[] {
    return this.frames.flatMap((f) => {
      const match = /^id: (\d+)/.exec(f);
      return match ? [Number(match[1])] : [];
    });
  }
  types(): string[] {
    return this.frames.flatMap((f) => {
      const match = /event: (\w+)/.exec(f);
      return match ? [match[1]] : [];
    });
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

function append(channelId: string, seq: number): ChannelEvent {
  const event: ChannelEvent = { channelId, seq, type: 'new_message', payload: { id: `m${seq}` } };
  log.set(channelId, [...(log.get(channelId) ?? []), event]);
  return event;
}

function connect(channelId: string, afterSeq: number | null) {
  const res = new FakeResponse();
  const joined = addClient(channelId, 'user-1', res as unknown as Response, afterSeq);
  return { res, joined };
}

beforeEach(() => {
  log.clear();
  vi.clearAllMocks();
});

afterEach(() => {
  closeAllStreams();
});

describe('channel streams', () => {
  it('replays events after the cursor, then delivers each live event once', async () => {
    for (let seq = 1; seq <= 5; seq++) append('c1', seq);
    const { res, joined } = connect('c1', 2);
    await joined;
    expect(res.ids()).toEqual([3, 4, 5]);

    // The writing instance delivers locally and also receives its own pub/sub copy.
    const live = append('c1', 6);
    deliverChannelEvent(live);
    deliverChannelEvent(live);
    await settle();
    expect(res.ids()).toEqual([3, 4, 5, 6]);
  });

  it('fills a gap from the log when pub/sub delivers events out of order', async () => {
    append('c2', 1);
    const { res, joined } = connect('c2', 1);
    await joined;

    const second = append('c2', 2);
    const third = append('c2', 3);
    deliverChannelEvent(third);
    deliverChannelEvent(second);
    await settle();

    expect(res.ids()).toEqual([2, 3]);
  });

  it('tells the client to resync when part of its gap was never logged', async () => {
    for (const seq of [1, 2, 4, 5]) append('c3', seq);
    const { res, joined } = connect('c3', 1);
    await joined;

    expect(res.types()).toEqual(['resync']);
    expect(res.frames[0]).toContain('"latestSeq":5');

    deliverChannelEvent(append('c3', 6));
    await settle();
    expect(res.ids()).toEqual([6]);
  });

  it('skips the replay and resyncs a client that is too far behind', async () => {
    append('c4', MAX_REPLAY_EVENTS + 10);
    const { res, joined } = connect('c4', 0);
    await joined;

    expect(res.types()).toEqual(['resync']);
    expect(channelEvents.readChannelEvents).not.toHaveBeenCalled();
  });

  it('subscribes once per channel and unsubscribes when the last viewer leaves', async () => {
    const first = connect('c5', null);
    const second = connect('c5', null);
    await Promise.all([first.joined, second.joined]);
    expect(pubsub.subscribeToChannel).toHaveBeenCalledTimes(1);

    first.res.end();
    expect(pubsub.unsubscribeFromChannel).not.toHaveBeenCalled();
    second.res.end();
    expect(pubsub.unsubscribeFromChannel).toHaveBeenCalledWith('c5');
    expect(getStreamStats()).toEqual({ channels: 0, clients: 0 });
  });

  it('catches up a stream whose publish was lost on the next head check', async () => {
    append('c6', 1);
    const { res, joined } = connect('c6', 1);
    await joined;

    append('c6', 2); // committed, but the pub/sub message never arrives
    await checkHeads();
    await settle();

    expect(res.ids()).toEqual([2]);
  });

  it('still delivers to local viewers when the Redis publish fails', async () => {
    const { res, joined } = connect('c7', 0);
    await joined;
    vi.mocked(pubsub.publishChannelEvent).mockRejectedValueOnce(new Error('redis down'));

    await expect(broadcastChannelEvent(append('c7', 1))).resolves.toBeUndefined();
    await settle();

    expect(res.ids()).toEqual([1]);
  });
});
