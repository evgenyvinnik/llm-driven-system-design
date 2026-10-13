/**
 * Unit tests for the RabbitMQ wrapper (services/queue.ts) with a fake amqplib:
 * bounded retries through the retry queue, dead-lettering, poison messages, publisher
 * confirms, and re-registering the consumer after the connection drops.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { EventEmitter } from 'node:events';

interface FakeChannel extends EventEmitter {
  consume: ReturnType<typeof vi.fn>;
  sendToQueue: ReturnType<typeof vi.fn>;
  ack: ReturnType<typeof vi.fn>;
  nack: ReturnType<typeof vi.fn>;
  assertQueue: ReturnType<typeof vi.fn>;
  onMessage?: (msg: unknown) => void;
}

interface FakeConnection extends EventEmitter {
  channel: FakeChannel;
}

const amqpState = vi.hoisted(() => ({ connections: [] as FakeConnection[] }));

vi.mock('amqplib', async () => {
  const { EventEmitter } = await import('node:events');
  const makeChannel = () => {
    const ch = new EventEmitter() as unknown as Record<string, unknown>;
    ch.assertExchange = vi.fn().mockResolvedValue({});
    ch.assertQueue = vi.fn().mockResolvedValue({});
    ch.bindQueue = vi.fn().mockResolvedValue({});
    ch.prefetch = vi.fn().mockResolvedValue(undefined);
    ch.consume = vi.fn().mockImplementation(async (_queue: string, onMessage: (msg: unknown) => void) => {
      ch.onMessage = onMessage;
      return { consumerTag: 'consumer-1' };
    });
    ch.sendToQueue = vi
      .fn()
      .mockImplementation((_queue: string, _content: Buffer, _options: unknown, cb?: (err: unknown) => void) => {
        cb?.(null);
        return true;
      });
    ch.ack = vi.fn();
    ch.nack = vi.fn();
    ch.cancel = vi.fn().mockResolvedValue(undefined);
    ch.close = vi.fn().mockResolvedValue(undefined);
    return ch;
  };
  const connect = vi.fn().mockImplementation(async () => {
    const conn = new EventEmitter() as unknown as Record<string, unknown>;
    conn.channel = makeChannel();
    conn.createConfirmChannel = vi.fn().mockResolvedValue(conn.channel);
    conn.close = vi.fn().mockResolvedValue(undefined);
    amqpState.connections.push(conn as unknown as FakeConnection);
    return conn;
  });
  return { default: { connect }, connect };
});

vi.mock('./metrics.js', () => ({
  imageJobOutcomes: { labels: vi.fn().mockReturnValue({ inc: vi.fn() }) },
}));

vi.mock('./logger.js', () => {
  const noop = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() };
  noop.child.mockReturnValue(noop);
  return { default: noop };
});

const job = {
  postId: 'ab111111-1111-1111-1111-111111111111',
  userId: '11111111-1111-1111-1111-111111111111',
  mediaItems: [{ originalKey: 'originals/a.jpg', filterName: 'none', orderIndex: 0 }],
};

const message = (body: unknown, attempt?: number) => ({
  content: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)),
  fields: { redelivered: false },
  properties: { messageId: 'm-1', headers: attempt ? { 'x-attempt': attempt } : {} },
});

type QueueModule = typeof import('./queue.js');
let queue: QueueModule;

beforeEach(async () => {
  vi.resetModules();
  amqpState.connections = [];
  queue = await import('./queue.js');
});

afterEach(() => {
  vi.useRealTimers();
});

describe('decideFailureAction', () => {
  it('retries until the last attempt, then dead-letters', () => {
    expect(queue.decideFailureAction(1, 3)).toBe('retry');
    expect(queue.decideFailureAction(2, 3)).toBe('retry');
    expect(queue.decideFailureAction(3, 3)).toBe('dead_letter');
  });
});

describe('consumer', () => {
  it('sends a failed job to the retry queue with the next attempt number, then acks it', async () => {
    const handler = vi.fn().mockRejectedValue(new Error('minio timeout'));
    await queue.consumeImageProcessingJobs(handler, { maxAttempts: 3 });
    const ch = amqpState.connections[0].channel;
    const msg = message(job, 1);

    ch.onMessage!(msg);

    await vi.waitFor(() => expect(ch.ack).toHaveBeenCalledWith(msg));
    expect(ch.sendToQueue).toHaveBeenCalledWith(
      queue.QUEUES.IMAGE_PROCESSING_RETRY,
      expect.any(Buffer),
      expect.objectContaining({ headers: { 'x-attempt': 2 }, persistent: true }),
      expect.any(Function)
    );
    expect(ch.nack).not.toHaveBeenCalled();
  });

  it('dead-letters the job on its last attempt and runs the dead-letter hook', async () => {
    const error = new Error('corrupt file');
    const handler = vi.fn().mockRejectedValue(error);
    const onDeadLetter = vi.fn().mockResolvedValue(undefined);
    await queue.consumeImageProcessingJobs(handler, { maxAttempts: 3, onDeadLetter });
    const ch = amqpState.connections[0].channel;
    const msg = message(job, 3);

    ch.onMessage!(msg);

    await vi.waitFor(() => expect(ch.nack).toHaveBeenCalledWith(msg, false, false));
    expect(onDeadLetter).toHaveBeenCalledWith(job, error);
    expect(ch.sendToQueue).not.toHaveBeenCalled();
  });

  it('dead-letters an unparseable message without calling the handler', async () => {
    const handler = vi.fn();
    await queue.consumeImageProcessingJobs(handler, { maxAttempts: 3 });
    const ch = amqpState.connections[0].channel;
    const msg = message('{not json');

    ch.onMessage!(msg);

    await vi.waitFor(() => expect(ch.nack).toHaveBeenCalledWith(msg, false, false));
    expect(handler).not.toHaveBeenCalled();
  });

  it('re-registers the consumer after the connection drops', async () => {
    vi.useFakeTimers();
    await queue.consumeImageProcessingJobs(vi.fn().mockResolvedValue(undefined), { maxAttempts: 3 });
    expect(amqpState.connections[0].channel.consume).toHaveBeenCalledTimes(1);

    amqpState.connections[0].emit('close');
    expect(queue.isQueueReady()).toBe(false);

    await vi.advanceTimersByTimeAsync(1000);

    expect(amqpState.connections).toHaveLength(2);
    expect(amqpState.connections[1].channel.consume).toHaveBeenCalledTimes(1);
    expect(queue.isQueueReady()).toBe(true);
  });
});

describe('publishImageProcessingJob', () => {
  it('fails fast without a channel so the outbox keeps the event', async () => {
    await expect(queue.publishImageProcessingJob(job)).rejects.toThrow('RabbitMQ channel not available');
  });

  it('resolves only after the broker confirms, and rejects on a broker nack', async () => {
    await queue.initializeQueue();
    const ch = amqpState.connections[0].channel;

    await expect(queue.publishImageProcessingJob(job)).resolves.toBeUndefined();
    expect(ch.sendToQueue).toHaveBeenCalledWith(
      queue.QUEUES.IMAGE_PROCESSING,
      expect.any(Buffer),
      expect.objectContaining({ headers: { 'x-attempt': 1 } }),
      expect.any(Function)
    );

    ch.sendToQueue.mockImplementationOnce(
      (_queue: string, _content: Buffer, _options: unknown, cb: (err: unknown) => void) => {
        cb(new Error('nacked'));
        return true;
      }
    );
    await expect(queue.publishImageProcessingJob(job)).rejects.toThrow('nacked');
  });

  it('declares the retry queue without touching the main queue arguments', async () => {
    await queue.initializeQueue();
    const ch = amqpState.connections[0].channel;

    expect(ch.assertQueue).toHaveBeenCalledWith(queue.QUEUES.IMAGE_PROCESSING, {
      durable: true,
      arguments: { 'x-dead-letter-exchange': 'instagram-dlx', 'x-dead-letter-routing-key': 'image-processing' },
    });
    expect(ch.assertQueue).toHaveBeenCalledWith(queue.QUEUES.IMAGE_PROCESSING_RETRY, {
      durable: true,
      arguments: {
        'x-message-ttl': queue.RETRY_DELAY_MS,
        'x-dead-letter-exchange': '',
        'x-dead-letter-routing-key': queue.QUEUES.IMAGE_PROCESSING,
      },
    });
  });
});
