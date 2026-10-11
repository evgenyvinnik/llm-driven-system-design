/**
 * Exercises the RabbitMQ module against an in-memory fake of amqplib's connection and
 * confirm channel: publisher confirms, backpressure, retry/dead-letter routing, and
 * consumer re-registration after a reconnect.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

vi.mock('amqplib', () => ({
  default: { connect: vi.fn() },
}));

interface Published {
  queue: string;
  content: Buffer;
  options: Record<string, unknown> & { headers?: Record<string, unknown> };
}

class FakeChannel extends EventEmitter {
  published: Published[] = [];
  asserted: Array<{ queue: string; options: unknown }> = [];
  acked: unknown[] = [];
  requeued: unknown[] = [];
  consumer: ((msg: unknown) => void) | null = null;
  /** How the broker answers publishes: per target queue, default 'ack'. */
  confirm: Record<string, 'ack' | 'nack' | 'never'> = {};
  writable = true;

  async assertQueue(queue: string, options: unknown) {
    this.asserted.push({ queue, options });
    return { queue, messageCount: 0, consumerCount: 0 };
  }
  async prefetch() {}
  async consume(_queue: string, callback: (msg: unknown) => void) {
    this.consumer = callback;
    return { consumerTag: 'ctag-1' };
  }
  sendToQueue(queue: string, content: Buffer, options: Published['options'], cb: (err: Error | null) => void) {
    this.published.push({ queue, content, options });
    const mode = this.confirm[queue] ?? 'ack';
    if (mode === 'ack') queueMicrotask(() => cb(null));
    if (mode === 'nack') queueMicrotask(() => cb(new Error('message nacked')));
    return this.writable;
  }
  ack(msg: unknown) {
    this.acked.push(msg);
  }
  nack(msg: unknown, _allUpTo: boolean, requeue: boolean) {
    if (requeue) this.requeued.push(msg);
  }
  async cancel() {}
  async close() {
    this.emit('close');
  }
}

class FakeConnection extends EventEmitter {
  channel = new FakeChannel();
  async createConfirmChannel() {
    return this.channel;
  }
  async close() {
    this.emit('close');
  }
}

const EVENT = {
  event_id: '3f1c9a52-6b7e-4d43-9a3e-2f5b8c1d0e47',
  short_code: 'abc123x',
  device_type: 'desktop',
  timestamp: '2026-10-10T12:00:00.000Z',
};

function delivery(body: unknown, headers: Record<string, unknown> = {}) {
  return {
    content: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)),
    fields: { deliveryTag: 1 },
    properties: { headers, contentType: 'application/json', messageId: 'msg-1', timestamp: 1 },
  };
}

/** Fresh queue module (module-level connection state) wired to fake connections. */
async function loadQueue(connections: FakeConnection[]) {
  vi.resetModules();
  const amqplib = (await import('amqplib')).default;
  const connect = vi.mocked(amqplib.connect);
  connect.mockReset();
  for (const conn of connections) {
    connect.mockResolvedValueOnce(conn as never);
  }
  const queue = await import('./queue.js');
  return { queue, connect };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('connectQueue', () => {
  it('declares the main queue with unchanged arguments plus the retry and dead-letter queues', async () => {
    const conn = new FakeConnection();
    const { queue } = await loadQueue([conn]);

    expect(await queue.connectQueue()).toBe(true);

    expect(conn.channel.asserted).toEqual([
      { queue: 'click-events', options: { durable: true, arguments: { 'x-message-ttl': 86400000 } } },
      {
        queue: 'click-events.retry',
        options: {
          durable: true,
          arguments: { 'x-dead-letter-exchange': '', 'x-dead-letter-routing-key': 'click-events' },
        },
      },
      { queue: 'click-events.dlq', options: { durable: true } },
    ]);
    await queue.closeQueue();
  });
});

describe('publishClickEvent', () => {
  let conn: FakeConnection;
  let queue: typeof import('./queue.js');

  beforeEach(async () => {
    conn = new FakeConnection();
    ({ queue } = await loadQueue([conn]));
    await queue.connectQueue();
  });

  afterEach(async () => {
    await queue.closeQueue();
  });

  it('resolves true only after the broker confirms', async () => {
    expect(await queue.publishClickEvent(EVENT)).toBe(true);
    const [message] = conn.channel.published;
    expect(message.queue).toBe('click-events');
    expect(message.options).toMatchObject({ persistent: true, messageId: EVENT.event_id });
  });

  it('resolves false when the broker nacks', async () => {
    conn.channel.confirm['click-events'] = 'nack';
    expect(await queue.publishClickEvent(EVENT)).toBe(false);
  });

  it('resolves false when no confirm arrives in time', async () => {
    vi.useFakeTimers();
    conn.channel.confirm['click-events'] = 'never';
    const pending = queue.publishClickEvent(EVENT);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await pending).toBe(false);
  });

  it('waits for drain after the buffer fills, and gives up if it never drains', async () => {
    vi.useFakeTimers();
    conn.channel.writable = false;
    expect(await queue.publishClickEvent(EVENT)).toBe(true); // buffered, still confirmed

    conn.channel.writable = true;
    const drained = queue.publishClickEvent(EVENT);
    conn.channel.emit('drain');
    expect(await drained).toBe(true);

    conn.channel.writable = false;
    await queue.publishClickEvent(EVENT);
    const stuck = queue.publishClickEvent(EVENT);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await stuck).toBe(false); // caller falls back to the direct insert
  });
});

describe('consumeClickEvents', () => {
  let conn: FakeConnection;
  let queue: typeof import('./queue.js');
  const handler = vi.fn();

  beforeEach(async () => {
    handler.mockReset();
    conn = new FakeConnection();
    ({ queue } = await loadQueue([conn]));
    await queue.consumeClickEvents(handler);
    await queue.connectQueue();
  });

  afterEach(async () => {
    await queue.closeQueue();
  });

  const deliver = (msg: ReturnType<typeof delivery>) => conn.channel.consumer!(msg);
  const lastPublished = () => conn.channel.published.at(-1)!;

  it('acks after the handler succeeds', async () => {
    handler.mockResolvedValue(undefined);
    const msg = delivery(EVENT);
    deliver(msg);
    await vi.waitFor(() => expect(conn.channel.acked).toEqual([msg]));
    expect(handler).toHaveBeenCalledWith(EVENT);
  });

  it('parks a transient failure on the retry queue with an incremented counter, then acks', async () => {
    handler.mockRejectedValue(new Error('database unavailable'));
    const msg = delivery(EVENT, { 'x-retry-count': 1, 'x-death': [{ count: 1 }] });
    deliver(msg);

    await vi.waitFor(() => expect(conn.channel.acked).toEqual([msg]));
    const retry = lastPublished();
    expect(retry.queue).toBe('click-events.retry');
    expect(retry.options.expiration).toBe('10000');
    expect(retry.options.headers).toMatchObject({ 'x-retry-count': 2, 'x-last-error': 'database unavailable' });
    expect(retry.options.headers).not.toHaveProperty('x-death');
    expect(retry.content.equals(msg.content)).toBe(true);
  });

  it('dead-letters once the attempt budget is spent', async () => {
    handler.mockRejectedValue(new Error('still failing'));
    const msg = delivery(EVENT, { 'x-retry-count': 4 }); // 5th attempt with maxAttempts = 5
    deliver(msg);

    await vi.waitFor(() => expect(conn.channel.acked).toEqual([msg]));
    expect(lastPublished().queue).toBe('click-events.dlq');
    expect(lastPublished().options.headers).toMatchObject({ 'x-dlq-reason': 'max_attempts', 'x-retry-count': 4 });
  });

  it('dead-letters permanent errors without retrying', async () => {
    handler.mockRejectedValue(Object.assign(new Error('violates foreign key'), { code: '23503' }));
    const msg = delivery(EVENT);
    deliver(msg);

    await vi.waitFor(() => expect(conn.channel.acked).toEqual([msg]));
    expect(conn.channel.published.map((p) => p.queue)).toEqual(['click-events.dlq']);
    expect(lastPublished().options.headers).toMatchObject({ 'x-dlq-reason': 'permanent_error' });
  });

  it('sends malformed payloads straight to the dead-letter queue', async () => {
    const msg = delivery('{not json');
    deliver(msg);

    await vi.waitFor(() => expect(conn.channel.acked).toEqual([msg]));
    expect(handler).not.toHaveBeenCalled();
    expect(lastPublished().options.headers).toMatchObject({ 'x-dlq-reason': 'malformed' });
  });

  it('requeues the original if the retry copy is not confirmed (never drops it)', async () => {
    vi.useFakeTimers();
    handler.mockRejectedValue(new Error('database unavailable'));
    conn.channel.confirm['click-events.retry'] = 'nack';
    const msg = delivery(EVENT);
    deliver(msg);

    await vi.advanceTimersByTimeAsync(1000);
    expect(conn.channel.requeued).toEqual([msg]);
    expect(conn.channel.acked).toEqual([]);
  });
});

describe('reconnection', () => {
  it('re-attaches the consumer after the connection drops', async () => {
    vi.useFakeTimers();
    const first = new FakeConnection();
    const second = new FakeConnection();
    const { queue, connect } = await loadQueue([first, second]);
    const handler = vi.fn().mockResolvedValue(undefined);

    await queue.consumeClickEvents(handler);
    await queue.connectQueue();
    expect(first.channel.consumer).not.toBeNull();

    first.emit('close'); // broker restart
    expect(queue.isQueueConnected()).toBe(false);

    await vi.advanceTimersByTimeAsync(5000); // first reconnect delay
    expect(connect).toHaveBeenCalledTimes(2);
    expect(queue.isQueueConnected()).toBe(true);
    expect(second.channel.consumer).not.toBeNull();

    const msg = delivery(EVENT);
    second.channel.consumer!(msg);
    await vi.waitFor(() => expect(second.channel.acked).toEqual([msg]));
    await queue.closeQueue();
  });

  it('keeps retrying with backoff when the broker is down at startup', async () => {
    vi.useFakeTimers();
    const conn = new FakeConnection();
    const { queue, connect } = await loadQueue([]);
    connect
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce(conn as never);

    expect(await queue.connectQueue()).toBe(false);
    await vi.advanceTimersByTimeAsync(5000); // 2nd attempt fails
    expect(connect).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(10000); // 3rd attempt after doubled delay
    expect(connect).toHaveBeenCalledTimes(3);
    expect(queue.isQueueConnected()).toBe(true);
    await queue.closeQueue();
  });
});
