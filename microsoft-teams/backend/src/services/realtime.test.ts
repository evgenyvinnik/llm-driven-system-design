import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import type { Response } from 'express';

// A fake ioredis: records SUBSCRIBE/UNSUBSCRIBE in order and loops PUBLISH
// back to every connection's 'message' listeners, like one Redis server would.
// vi.mock factories are hoisted, so shared state goes through vi.hoisted.
const h = vi.hoisted(() => ({
  redisCalls: [] as string[],
  instances: [] as Array<{ emit: (event: string, ...args: unknown[]) => boolean }>,
}));
const redisCalls = h.redisCalls;

vi.mock('ioredis', async () => {
  const { EventEmitter: Emitter } = await import('events');
  class FakeRedis extends Emitter {
    constructor() {
      super();
      h.instances.push(this);
    }
    async subscribe(ch: string) {
      h.redisCalls.push(`SUBSCRIBE ${ch}`);
    }
    async unsubscribe(ch: string) {
      h.redisCalls.push(`UNSUBSCRIBE ${ch}`);
    }
    async publish(ch: string, msg: string) {
      for (const r of h.instances) r.emit('message', ch, msg);
      return 1;
    }
    async quit() {}
  }
  return { default: FakeRedis };
});
vi.mock('./logger.js', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
vi.mock('./metrics.js', () => ({ sseConnectionsGauge: { inc: vi.fn(), dec: vi.fn() } }));

import {
  initPubSub,
  subscribeToChannel,
  unsubscribeFromChannel,
  localSubscriberCount,
  publishToChannel,
  evictFromChannels,
} from './pubsub.js';
import { addClient } from './sseService.js';

/** Minimal stand-in for an SSE response stream. */
function fakeRes() {
  const res = new EventEmitter() as EventEmitter & { written: string[]; ended: boolean };
  res.written = [];
  res.ended = false;
  Object.assign(res, {
    write: (chunk: string) => res.written.push(chunk),
    end: () => {
      res.ended = true;
      res.emit('close');
    },
  });
  return res;
}

beforeAll(async () => {
  await initPubSub();
});

beforeEach(() => {
  redisCalls.length = 0;
});

describe('pub/sub subscription refcounting', () => {
  it('subscribes on the first local client and unsubscribes after the last', async () => {
    await subscribeToChannel('c1');
    await subscribeToChannel('c1');
    expect(localSubscriberCount('c1')).toBe(2);
    expect(redisCalls).toEqual(['SUBSCRIBE teams:channel:c1']);

    await unsubscribeFromChannel('c1');
    expect(redisCalls).toEqual(['SUBSCRIBE teams:channel:c1']);
    await unsubscribeFromChannel('c1');
    expect(redisCalls).toEqual(['SUBSCRIBE teams:channel:c1', 'UNSUBSCRIBE teams:channel:c1']);
    expect(localSubscriberCount('c1')).toBe(0);
  });

  it('re-subscribes when a client arrives right after the last one left', async () => {
    await subscribeToChannel('c2');
    const leaving = unsubscribeFromChannel('c2');
    const joining = subscribeToChannel('c2');
    await Promise.all([leaving, joining]);
    expect(redisCalls).toEqual([
      'SUBSCRIBE teams:channel:c2',
      'UNSUBSCRIBE teams:channel:c2',
      'SUBSCRIBE teams:channel:c2',
    ]);
    expect(localSubscriberCount('c2')).toBe(1);
    await unsubscribeFromChannel('c2');
  });
});

describe('SSE eviction on membership removal', () => {
  it('closes only the removed user’s streams, after telling everyone', async () => {
    const alice = fakeRes();
    const bob = fakeRes();
    addClient('c3', 'alice', alice as unknown as Response);
    addClient('c3', 'bob', bob as unknown as Response);

    await evictFromChannels(['c3'], 'bob');

    expect(bob.ended).toBe(true);
    expect(alice.ended).toBe(false);
    expect(alice.written.join('')).toContain('event: member_removed');

    // Bob no longer receives the channel's traffic; Alice still does.
    await publishToChannel('c3', 'new_message', { id: 'm1' });
    expect(alice.written.join('')).toContain('"id":"m1"');
    expect(bob.written.join('')).not.toContain('"id":"m1"');
  });
});
