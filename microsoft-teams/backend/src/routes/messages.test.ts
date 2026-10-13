import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/access.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/access.js')>()),
  getChannelAccess: vi.fn(),
  getMessageAccess: vi.fn(),
}));
vi.mock('../services/messageService.js', () => ({
  getChannelHistory: vi.fn(),
  getThreadMessages: vi.fn(),
  createMessage: vi.fn(),
  editMessage: vi.fn(),
  deleteMessage: vi.fn(),
}));
vi.mock('../services/sseService.js', () => ({
  broadcastChannelEvent: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../services/rateLimiter.js', () => ({
  messageLimiter: (_req: Request, _res: Response, next: NextFunction) => next(),
}));
vi.mock('../services/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { getChannelAccess } from '../services/access.js';
import { createMessage, getChannelHistory } from '../services/messageService.js';
import { broadcastChannelEvent } from '../services/sseService.js';
import messageRoutes from './messages.js';

const CHANNEL = 'cccccccc-0000-0000-0000-000000000001';
const CLIENT_ID = '5d1c6a3e-8f7b-4c2a-9e1d-2b3c4d5e6f70';

const access = {
  orgId: 'aaaaaaaa-0000-0000-0000-000000000001',
  teamId: 'bbbbbbbb-0000-0000-0000-000000000001',
  channelId: CHANNEL,
  orgRole: 'member',
  teamRole: 'member',
  teamPrivate: false,
  channelPrivate: false,
  channelMember: true,
};

const message = { id: 'm-1', channel_id: CHANNEL, seq: 42, content: 'hi', client_message_id: CLIENT_ID };

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.session = { userId: '11111111-1111-1111-1111-111111111111', username: 'alice' } as Request['session'];
  next();
});
app.use('/api/messages', messageRoutes);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getChannelAccess).mockResolvedValue(access);
});

describe('POST /api/messages', () => {
  const send = () =>
    request(app)
      .post('/api/messages')
      .send({ channelId: CHANNEL, content: 'hi', clientMessageId: CLIENT_ID });

  it('creates the message and fans out its event', async () => {
    const event = { channelId: CHANNEL, seq: 42, type: 'new_message', payload: message };
    vi.mocked(createMessage).mockResolvedValue({ kind: 'created', message, event } as never);

    const res = await send();

    expect(res.status).toBe(201);
    expect(res.body.message.seq).toBe(42);
    expect(broadcastChannelEvent).toHaveBeenCalledWith(event);
  });

  it('answers a retry with the original message and no second event', async () => {
    vi.mocked(createMessage).mockResolvedValue({ kind: 'replayed', message } as never);

    const res = await send();

    expect(res.status).toBe(200);
    expect(res.headers['idempotent-replayed']).toBe('true');
    expect(res.body.message.id).toBe('m-1');
    expect(broadcastChannelEvent).not.toHaveBeenCalled();
  });

  it('rejects a clientMessageId reused for a different message with 422', async () => {
    vi.mocked(createMessage).mockResolvedValue({ kind: 'key_conflict' });
    expect((await send()).status).toBe(422);
  });

  it('answers 404 for a channel the caller cannot read, without touching it', async () => {
    vi.mocked(getChannelAccess).mockResolvedValue(null);

    const res = await send();

    expect(res.status).toBe(404);
    expect(createMessage).not.toHaveBeenCalled();
  });

  it('validates the idempotency key format', async () => {
    const res = await request(app)
      .post('/api/messages')
      .send({ channelId: CHANNEL, content: 'hi', clientMessageId: 'not-a-uuid' });
    expect(res.status).toBe(400);
  });
});

describe('GET /api/messages', () => {
  it('pages by seq and caps the page size', async () => {
    vi.mocked(getChannelHistory).mockResolvedValue({ messages: [], latestSeq: 7, hasMore: false });

    const res = await request(app).get(`/api/messages?channelId=${CHANNEL}&before=10&limit=500`);

    expect(res.status).toBe(200);
    expect(res.body.latestSeq).toBe(7);
    expect(getChannelHistory).toHaveBeenCalledWith(CHANNEL, { before: 10, limit: 100 });
  });

  it('rejects a timestamp cursor', async () => {
    const res = await request(app).get(
      `/api/messages?channelId=${CHANNEL}&before=2026-10-10T00:00:00Z`,
    );
    expect(res.status).toBe(400);
  });
});
