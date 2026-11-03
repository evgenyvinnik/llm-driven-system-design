import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import type { RequestHandler } from 'express';
import { WebSocket } from 'ws';

vi.mock('../services/db.js', () => ({ pool: { query: vi.fn(), connect: vi.fn() } }));
vi.mock('../services/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock('../services/metrics.js', () => ({
  activeMeetings: { inc: vi.fn(), dec: vi.fn() },
  activeParticipants: { inc: vi.fn(), dec: vi.fn() },
  wsConnections: { inc: vi.fn(), dec: vi.fn() },
}));
vi.mock('../config/index.js', () => ({
  config: {
    allowedOrigins: ['http://localhost:5173'],
    ws: { reconnectGraceMs: 0, emptyMeetingGraceMs: 60000, heartbeatIntervalMs: 60000, maxPayloadBytes: 65536 },
  },
}));
vi.mock('../services/meetingService.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/meetingService.js')>();
  return {
    ...actual,
    getMeetingByCode: vi.fn().mockResolvedValue({
      id: 'b0000000-0000-0000-0000-000000000001',
      meeting_code: 'abc-defg-hij',
      title: 'Standup',
      host_id: 'a0000000-0000-0000-0000-000000000001',
      status: 'active',
      settings: {},
    }),
    autoStartMeeting: vi.fn().mockResolvedValue(undefined),
    upsertParticipant: vi.fn().mockResolvedValue({}),
    leaveMeeting: vi.fn().mockResolvedValue(null),
  };
});

import { setupWebSocket } from './handler.js';

const ALICE = 'a0000000-0000-0000-0000-000000000001';
const BOB = 'a0000000-0000-0000-0000-000000000002';

// Stand-in for express-session: the test names the session user in a cookie.
const fakeSession: RequestHandler = (req, _res, next) => {
  const match = /sid=([\w-]+)/.exec(req.headers.cookie ?? '');
  (req as unknown as { session?: object }).session = match
    ? { userId: match[1], username: match[1] === ALICE ? 'alice' : 'bob' }
    : {};
  next();
};

let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer();
  setupWebSocket(server, fakeSession);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function open(path: string, headers: Record<string, string> = {}) {
  const ws = new WebSocket(`${base}${path}`, { headers });
  const messages: Array<Record<string, unknown>> = [];
  ws.on('message', (data) => messages.push(JSON.parse(data.toString())));
  return { ws, messages };
}

const closed = (ws: WebSocket) => new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)));

describe('signaling socket authentication', () => {
  it('closes unauthenticated sockets with 4001, whatever the query string claims', async () => {
    const { ws } = open(`/ws?userId=${ALICE}&username=alice`);
    expect(await closed(ws)).toBe(4001);
  });

  it('takes identity from the session, ignoring a spoofed userId', async () => {
    const { ws, messages } = open(`/ws?userId=${ALICE}&username=alice`, { cookie: `sid=${BOB}` });
    await new Promise((resolve) => ws.on('open', resolve));
    ws.send(JSON.stringify({ type: 'join-meeting', meetingCode: 'abc-defg-hij', displayName: 'Bob' }));
    await vi.waitFor(() => expect(messages.find((m) => m.type === 'joined')).toBeTruthy());
    const joined = messages.find((m) => m.type === 'joined')!;
    // Bob claimed to be the organizer in the query string; he is still just a participant.
    expect(joined.self).toMatchObject({ userId: BOB });
    expect(joined.role).toBe('participant');
    ws.close();
    await closed(ws);
  });

  it('refuses browser upgrades from other origins', async () => {
    const { ws } = open('/ws', { cookie: `sid=${BOB}`, origin: 'http://evil.example' });
    const error = await new Promise<Error>((resolve) => ws.on('error', resolve));
    expect(error.message).toMatch(/403/);
  });

  it('rejects malformed messages without dropping the socket', async () => {
    const { ws, messages } = open('/ws', { cookie: `sid=${BOB}` });
    await new Promise((resolve) => ws.on('open', resolve));
    ws.send('not json');
    ws.send(JSON.stringify({ type: 'end-meeting' }));
    await vi.waitFor(() => expect(messages.length).toBe(2));
    expect(messages[0]).toMatchObject({ type: 'error', code: 'invalid' });
    expect(messages[1]).toMatchObject({ type: 'error', code: 'not-in-meeting' });
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
    await closed(ws);
  });
});
