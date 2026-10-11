import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

vi.mock('../services/db.js', () => ({ pool: { query: vi.fn(), connect: vi.fn() } }));
vi.mock('../services/redis.js', () => ({
  redis: { call: vi.fn(), ping: vi.fn(), on: vi.fn(), get: vi.fn(), set: vi.fn(), del: vi.fn() },
  connectRedis: vi.fn(),
}));
vi.mock('../services/storageService.js', () => ({
  getPresignedDownloadUrl: vi.fn(async (key: string) => `https://storage.local/${key}?X-Amz-Signature=sig`),
  deleteObject: vi.fn(),
  isNotFoundError: () => false,
}));

import { pool } from '../services/db.js';
import { app } from '../app.js';

const query = pool.query as unknown as ReturnType<typeof vi.fn>;

const OWNER = 'a1111111-1111-1111-1111-111111111111';
const VIDEO = '33333333-aaaa-4aaa-8aaa-333333333333';
const SHARE = '50000002-0000-4000-8000-000000000002';
// bcrypt hash of "password123" (the seeded share password)
const HASH = '$2b$10$BdLsE.kQm5ryFusMBZ8QjOO.qRkLW/.iX7Wt7G3ZP3tGtFhtO1Rpi';

const state = { shareLive: true, upserts: 0 };

const videoRow = {
  id: VIDEO,
  user_id: OWNER,
  title: 'Design review',
  status: 'ready',
  storage_path: `${OWNER}/${VIDEO}/playback.webm`,
  thumbnail_path: null,
  duration_seconds: 725,
  view_count: 3,
};

function shareRow(token: string) {
  if (token === 'locked-token') {
    return { id: SHARE, video_id: VIDEO, password_hash: HASH, expires_at: null, allow_download: false };
  }
  if (token === 'expired-token') {
    return { id: SHARE, video_id: VIDEO, password_hash: null, expires_at: new Date(Date.now() - 1000), allow_download: false };
  }
  return undefined;
}

beforeEach(() => {
  state.shareLive = true;
  state.upserts = 0;
  query.mockReset();
  query.mockImplementation(async (sql: string, params: unknown[] = []) => {
    if (sql.includes('FROM shares WHERE token')) {
      const row = shareRow(params[0] as string);
      return { rows: row ? [row] : [] };
    }
    if (sql.includes('FROM shares') && sql.includes('ANY')) {
      return { rows: state.shareLive ? [{ id: SHARE }] : [] };
    }
    if (sql.includes('JOIN users u ON u.id = v.user_id')) {
      return { rows: [{ ...videoRow, username: 'alice', display_name: 'Alice', avatar_url: null }] };
    }
    if (sql.includes('SELECT * FROM videos WHERE id = $1')) {
      return { rows: params[0] === VIDEO ? [videoRow] : [] };
    }
    if (sql.includes('FROM users WHERE id')) {
      return { rows: [{ username: 'alice', display_name: 'Alice', avatar_url: null }] };
    }
    if (sql.includes('WITH upsert AS')) {
      state.upserts++;
      return { rows: [{ inserted: state.upserts === 1 }] };
    }
    return { rows: [] };
  });
});

async function unlock() {
  const res = await request(app)
    .post('/api/share/locked-token/unlock')
    .send({ password: 'password123' });
  expect(res.status).toBe(200);
  const cookie = (res.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('loom_share_grants='));
  expect(cookie).toBeDefined();
  return cookie!.split(';')[0];
}

describe('video reads require ownership or a share grant', () => {
  it.each([
    `/api/videos/${VIDEO}`,
    `/api/upload/download/${VIDEO}`,
    `/api/videos/${VIDEO}/comments`,
  ])('anonymous GET %s is 404', async (path) => {
    const res = await request(app).get(path);
    expect(res.status).toBe(404);
  });

  it('a grant from unlocking the share opens metadata, playback and comments', async () => {
    const grant = await unlock();

    const video = await request(app).get(`/api/videos/${VIDEO}`).set('Cookie', grant);
    expect(video.status).toBe(200);
    expect(video.body.video.access).toBe('viewer');
    expect(video.body.video.storagePath).toBeUndefined();

    const download = await request(app).get(`/api/upload/download/${VIDEO}`).set('Cookie', grant);
    expect(download.status).toBe(200);
    expect(download.body.downloadUrl).toContain('playback.webm');

    const comments = await request(app).get(`/api/videos/${VIDEO}/comments`).set('Cookie', grant);
    expect(comments.status).toBe(200);
  });

  it('revoking the share cuts off a browser that already holds a grant', async () => {
    const grant = await unlock();
    state.shareLive = false;
    const res = await request(app).get(`/api/upload/download/${VIDEO}`).set('Cookie', grant);
    expect(res.status).toBe(404);
  });

  it('owner-only analytics stay closed to share viewers', async () => {
    const grant = await unlock();
    const res = await request(app).get(`/api/analytics/${VIDEO}/analytics`).set('Cookie', grant);
    expect(res.status).toBe(401);
  });
});

describe('password-protected shares', () => {
  it('asks for the password without issuing a grant', async () => {
    const res = await request(app).get('/api/share/locked-token');
    expect(res.status).toBe(401);
    expect(res.body.requiresPassword).toBe(true);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('ignores a password in the query string (it would end up in access logs)', async () => {
    const res = await request(app).get('/api/share/locked-token?password=password123');
    expect(res.status).toBe(401);
  });

  it('rejects a wrong password', async () => {
    const res = await request(app).post('/api/share/locked-token/unlock').send({ password: 'nope' });
    expect(res.status).toBe(401);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('remembers a correct password so later opens skip it', async () => {
    const grant = await unlock();
    const res = await request(app).get('/api/share/locked-token').set('Cookie', grant);
    expect(res.status).toBe(200);
    expect(res.body.video.downloadUrl).toContain('X-Amz-Signature');
  });

  it('answers 410 for an expired link and 404 for an unknown one', async () => {
    expect((await request(app).get('/api/share/expired-token')).status).toBe(410);
    expect((await request(app).get('/api/share/no-such-token')).status).toBe(404);
  });

  it('rate-limits password guessing per link', async () => {
    let last = 0;
    for (let i = 0; i < 11; i++) {
      last = (await request(app).post('/api/share/locked-token/unlock').set('X-Test', String(i)).send({ password: `guess-${i}` })).status;
    }
    expect(last).toBe(429);
  });
});

describe('view tracking', () => {
  it('counts one view per viewId and treats repeats as heartbeats', async () => {
    const grant = await unlock();
    const body = {
      videoId: VIDEO,
      viewId: '0f0e0d0c-0b0a-4908-8706-050403020100',
      sessionId: 'viewer-key',
      watchDurationSeconds: 12.6,
      completed: false,
    };
    const first = await request(app).post('/api/analytics/view').set('Cookie', grant).send(body);
    const second = await request(app)
      .post('/api/analytics/view')
      .set('Cookie', grant)
      .send({ ...body, watchDurationSeconds: 40 });
    expect(first.body).toEqual({ recorded: true, newView: true });
    expect(second.body).toEqual({ recorded: true, newView: false });
  });

  it('refuses views for videos the caller cannot watch, and malformed reports', async () => {
    const body = { videoId: VIDEO, viewId: '0f0e0d0c-0b0a-4908-8706-050403020100', sessionId: 'k' };
    expect((await request(app).post('/api/analytics/view').send(body)).status).toBe(404);
    expect((await request(app).post('/api/analytics/view').send({ ...body, viewId: 'x' })).status).toBe(400);
    expect(
      (await request(app).post('/api/analytics/view').send({ ...body, watchDurationSeconds: -5 })).status,
    ).toBe(400);
  });
});
