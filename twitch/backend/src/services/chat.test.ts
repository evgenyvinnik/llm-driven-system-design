import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import { WebSocket, WebSocketServer } from 'ws';

// Mock shared modules before importing the chat service
const query = vi.fn();
vi.mock('./database.js', () => ({ query: (...args: unknown[]) => query(...args) }));

const getSession = vi.fn();
const publishMessage = vi.fn();
vi.mock('./redis.js', () => ({
  publishMessage: (...args: unknown[]) => publishMessage(...args),
  subscribe: vi.fn().mockResolvedValue(undefined),
  unsubscribe: vi.fn().mockResolvedValue(undefined),
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
  getRedisClient: vi.fn(),
  getSession: (...args: unknown[]) => getSession(...args),
}));

vi.mock('../utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  logChatEvent: vi.fn(),
}));
vi.mock('../utils/metrics.js', () => ({
  incChatMessage: vi.fn(),
  incChatRateLimited: vi.fn(),
  incWsConnection: vi.fn(),
  decWsConnection: vi.fn(),
}));
vi.mock('../utils/idempotency.js', () => ({
  checkChatMessageDedup: vi.fn().mockResolvedValue({ dropped: false }),
  generateChatMessageId: () => `msg_${Math.random()}`,
}));
vi.mock('../utils/circuitBreaker.js', () => ({
  createCircuitBreaker: (_name: string, fn: (...args: unknown[]) => unknown) => ({
    fallback: vi.fn(),
    fire: (...args: unknown[]) => fn(...args),
  }),
}));

import { setupChatWebSocket } from './chat.js';

const USERS: Record<number, { username: string; role: string }> = {
  1: { username: 'alice', role: 'user' },
  2: { username: 'bob', role: 'user' },
};
const SESSIONS: Record<string, number> = { 'sid-alice': 1, 'sid-bob': 2 };
const BANNED = new Set(['5:2']); // bob is banned in channel 5

let server: http.Server;
let url: string;

/** Opens a socket and collects every message it receives. */
const open = async (cookie?: string) => {
  const ws = new WebSocket(url, cookie ? { headers: { Cookie: cookie } } : undefined);
  const messages: Array<Record<string, unknown>> = [];
  ws.on('message', (data) => messages.push(JSON.parse(data.toString())));
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  const next = (type: string) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const deadline = Date.now() + 2000;
      const poll = () => {
        const index = messages.findIndex((m) => m.type === type);
        if (index >= 0) return resolve(messages.splice(index, 1)[0]);
        if (Date.now() > deadline) return reject(new Error(`no ${type} message`));
        setTimeout(poll, 10);
      };
      poll();
    });
  return { ws, next, send: (msg: unknown) => ws.send(JSON.stringify(msg)) };
};

beforeAll(async () => {
  query.mockImplementation(async (sql: string, params: unknown[] = []) => {
    if (sql.includes('FROM users')) {
      const user = USERS[params[0] as number];
      return { rows: user ? [user] : [] };
    }
    if (sql.includes('FROM channel_bans')) {
      return { rows: BANNED.has(`${params[0]}:${params[1]}`) ? [{}] : [] };
    }
    return { rows: [] };
  });
  getSession.mockImplementation(async (sid: string) => SESSIONS[sid] ?? null);

  server = http.createServer();
  setupChatWebSocket(server, new WebSocketServer({ noServer: true }), {} as never);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/ws/chat`;
});

afterAll(() => {
  server.close();
});

beforeEach(() => {
  publishMessage.mockClear();
});

describe('chat WebSocket identity', () => {
  it('binds the socket to the session cookie user and ignores a userId in auth', async () => {
    const alice = await open('session=sid-alice');
    expect(await alice.next('auth_success')).toMatchObject({ userId: 1, username: 'alice' });

    alice.send({ type: 'auth', userId: 2, username: 'bob' });
    expect(await alice.next('auth_success')).toMatchObject({ userId: 1, username: 'alice' });
    alice.ws.close();
  });

  it('treats a socket without a session as a guest that cannot chat', async () => {
    const guest = await open();
    expect(await guest.next('auth_success')).toMatchObject({ userId: null, isGuest: true });

    guest.send({ type: 'auth', userId: 1, username: 'alice' });
    expect(await guest.next('auth_success')).toMatchObject({ userId: null, isGuest: true });

    guest.send({ type: 'join', channelId: 5 });
    await guest.next('joined');
    guest.send({ type: 'chat', channelId: 5, text: 'hello' });
    expect(await guest.next('error')).toMatchObject({ message: 'Log in to chat' });
    expect(publishMessage).not.toHaveBeenCalled();
    guest.ws.close();
  });

  it('rejects an unknown session id as a guest, not as the id it names', async () => {
    const forged = await open('session=1');
    expect(await forged.next('auth_success')).toMatchObject({ userId: null, isGuest: true });
    forged.ws.close();
  });
});

describe('chat WebSocket writes', () => {
  it('requires joining the channel before chatting in it', async () => {
    const alice = await open('session=sid-alice');
    await alice.next('auth_success');
    alice.send({ type: 'chat', channelId: 5, text: 'hello' });
    expect(await alice.next('error')).toMatchObject({ message: 'Join the channel before chatting' });

    alice.send({ type: 'join', channelId: 5 });
    await alice.next('joined');
    alice.send({ type: 'chat', channelId: 5, text: 'hello' });
    await vi.waitFor(() => expect(publishMessage).toHaveBeenCalledTimes(1));
    expect(publishMessage.mock.calls[0][0]).toBe('chat:5');
    expect(publishMessage.mock.calls[0][1]).toMatchObject({ userId: 1, username: 'alice', message: 'hello' });
    alice.ws.close();
  });

  it('refuses chat from a banned session user', async () => {
    const bob = await open('session=sid-bob');
    await bob.next('auth_success');
    bob.send({ type: 'join', channelId: 5 });
    await bob.next('joined');
    bob.send({ type: 'chat', channelId: 5, text: 'evading' });
    expect(await bob.next('error')).toMatchObject({ message: 'You are banned from this channel' });
    expect(publishMessage).not.toHaveBeenCalled();
    bob.ws.close();
  });
});
