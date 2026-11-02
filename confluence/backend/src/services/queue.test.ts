import { describe, it, expect, vi, beforeEach } from 'vitest';

const sent: string[] = [];
let failNext = false;
const channel = {
  assertQueue: vi.fn().mockResolvedValue(undefined),
  sendToQueue: vi.fn((_q: string, body: Buffer, _o: unknown, cb: (err?: Error) => void) => {
    setTimeout(() => {
      if (failNext) {
        failNext = false;
        cb(new Error('nack'));
        return;
      }
      sent.push(JSON.parse(body.toString()).n);
      cb();
    }, 5);
  }),
};
let connectFails = true;
vi.mock('amqplib', () => ({
  default: {
    connect: vi.fn(async () => {
      if (connectFails) throw new Error('ECONNREFUSED');
      return { on: vi.fn(), createConfirmChannel: vi.fn().mockResolvedValue(channel) };
    }),
  },
}));
vi.mock('./logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { connectQueue, publishToQueue } from './queue.js';

beforeEach(() => {
  sent.length = 0;
});

describe('publishToQueue', () => {
  it('buffers while the broker is down and delivers everything, in order, on connect', async () => {
    connectFails = true;
    await connectQueue();
    expect(await publishToQueue('q', { n: 1 })).toBe(false);
    expect(await publishToQueue('q', { n: 2 })).toBe(false);

    connectFails = false;
    await connectQueue();
    await new Promise((r) => setTimeout(r, 50));
    expect(sent).toEqual([1, 2]);

    // Overlapping publishes after a nack must not skip or reorder anything.
    failNext = true;
    await publishToQueue('q', { n: 3 });
    await Promise.all([publishToQueue('q', { n: 4 }), publishToQueue('q', { n: 5 })]);
    await new Promise((r) => setTimeout(r, 100));
    expect(sent).toEqual([1, 2, 3, 4, 5]);
  });
});
