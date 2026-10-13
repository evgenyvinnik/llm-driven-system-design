import { afterEach, describe, expect, it, vi } from 'vitest';

interface FakeConnection {
  handlers: Record<string, () => void>;
  channel: Record<string, ReturnType<typeof vi.fn>>;
  on: (event: string, handler: () => void) => void;
  createChannel: () => Promise<unknown>;
  close: ReturnType<typeof vi.fn>;
}

const broker = vi.hoisted(() => ({
  connections: [] as FakeConnection[],
  failures: 0,
}));

vi.mock('amqplib', () => ({
  default: {
    connect: vi.fn(async () => {
      if (broker.failures > 0) {
        broker.failures--;
        throw new Error('ECONNREFUSED');
      }
      const handlers: Record<string, () => void> = {};
      const channel = {
        prefetch: vi.fn(),
        assertExchange: vi.fn(),
        assertQueue: vi.fn(),
        bindQueue: vi.fn(),
        consume: vi.fn(),
        close: vi.fn(),
      };
      const connection: FakeConnection = {
        handlers,
        channel,
        on: (event, handler) => {
          handlers[event] = handler;
        },
        createChannel: async () => channel,
        close: vi.fn(async () => handlers.close?.()),
      };
      broker.connections.push(connection);
      return connection;
    }),
  },
}));
vi.mock('./logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { closeMessageQueue, consumeQueue, initializeMessageQueue, QUEUES } from './messageQueue.js';

afterEach(() => vi.useRealTimers());

describe('RabbitMQ consumers across reconnects', () => {
  it('starts registered consumers on connect and again after the connection drops', async () => {
    vi.useFakeTimers();
    broker.failures = 1;

    // Broker down at startup: no channel yet, a reconnect is scheduled.
    expect(await initializeMessageQueue()).toBeNull();
    await consumeQueue(QUEUES.SEARCH_INDEX, async () => {});
    expect(broker.connections).toHaveLength(0);

    // First reconnect succeeds and starts the consumer registered while disconnected.
    await vi.advanceTimersByTimeAsync(5000);
    expect(broker.connections).toHaveLength(1);
    expect(broker.connections[0].channel.consume).toHaveBeenCalledWith(
      QUEUES.SEARCH_INDEX,
      expect.any(Function),
      { noAck: false }
    );

    // The broker restarts: the old channel is gone, and the consumer must come back.
    broker.connections[0].handlers.close();
    await vi.advanceTimersByTimeAsync(5000);
    expect(broker.connections).toHaveLength(2);
    expect(broker.connections[1].channel.consume).toHaveBeenCalledTimes(1);

    // A deliberate shutdown does not reconnect.
    await closeMessageQueue();
    await vi.advanceTimersByTimeAsync(120000);
    expect(broker.connections).toHaveLength(2);
  });
});
