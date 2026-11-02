import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';

/**
 * Route-level authorization tests. Postgres is replaced by a small SQL router:
 * each test registers what the queries it cares about return, and anything
 * unregistered returns no rows. Sessions use express-session's MemoryStore in
 * place of Redis, and login goes through the real /api/auth/login handler.
 */
type Result = { rows: unknown[] };
type Handler = (params: unknown[]) => Result | undefined;
const h = vi.hoisted(() => ({
  routes: [] as Array<[RegExp, (params: unknown[]) => { rows: unknown[] } | undefined]>,
}));

vi.mock('./services/db.js', () => {
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    for (const [re, handler] of h.routes) {
      if (re.test(sql)) {
        const result = handler(params);
        if (result) return result;
      }
    }
    return { rows: [] };
  });
  return {
    pool: { query },
    withTransaction: vi.fn(async (fn: (c: { query: typeof query }) => unknown) => fn({ query })),
  };
});
vi.mock('./services/redis.js', () => ({ redis: {}, connectRedis: vi.fn() }));
vi.mock('./services/pubsub.js', () => ({
  publishToChannel: vi.fn(),
  subscribeToChannel: vi.fn(),
  unsubscribeFromChannel: vi.fn(),
  evictFromChannels: vi.fn(),
}));
vi.mock('./services/storageService.js', () => ({
  uploadFile: vi.fn(),
  getPresignedUrl: vi.fn().mockResolvedValue('http://minio/presigned'),
  deleteFile: vi.fn().mockResolvedValue(undefined),
  ensureBucket: vi.fn(),
}));
vi.mock('connect-redis', async () => {
  const session = await import('express-session');
  return { default: session.default.MemoryStore };
});

import { app } from './app.js';
import { pool } from './services/db.js';
import { publishToChannel, subscribeToChannel, evictFromChannels } from './services/pubsub.js';
import { getPresignedUrl } from './services/storageService.js';

const query = vi.mocked(pool.query);

const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const ORG = 'aaaaaaaa-0000-4000-8000-000000000001';
const TEAM = 'bbbbbbbb-0000-4000-8000-000000000001';
const CHANNEL = 'cccccccc-0000-4000-8000-000000000001';
const OTHER_CHANNEL = 'cccccccc-0000-4000-8000-000000000002';
const MSG = 'dddddddd-0000-4000-8000-000000000001';
const FILE = 'ffffffff-0000-4000-8000-000000000001';

function on(re: RegExp, result: unknown[] | Handler) {
  h.routes.push([re, typeof result === 'function' ? result : () => ({ rows: result })]);
}

/** Channel access row: who the caller is in relation to `channelId`. */
function channelAccess(access: Record<string, { team: string | null; private?: boolean; member?: boolean }>) {
  on(/FROM channels c\s+JOIN teams t/, (params) => {
    const a = access[params[0] as string];
    if (!a) return { rows: [] };
    return {
      rows: [
        {
          id: params[0],
          team_id: TEAM,
          org_id: ORG,
          is_private: a.private ?? false,
          created_by: ALICE,
          org_role: a.team ? 'member' : null,
          team_role: a.team,
          is_channel_member: a.member ?? !!a.team,
        },
      ],
    };
  });
}

let agent: ReturnType<typeof request.agent>;

beforeAll(async () => {
  const hash = bcrypt.hashSync('password123', 4);
  h.routes = [];
  on(/FROM users WHERE username = \$1/, [
    { id: ALICE, username: 'alice', email: 'a@x', password_hash: hash, display_name: 'Alice', role: 'user' },
  ]);
  agent = request.agent(app);
  const res = await agent.post('/api/auth/login').send({ username: 'alice', password: 'password123' });
  expect(res.status).toBe(200);
});

beforeEach(() => {
  h.routes = [];
  query.mockClear();
  vi.mocked(publishToChannel).mockClear();
  vi.mocked(subscribeToChannel).mockClear();
  vi.mocked(evictFromChannels).mockClear();
  vi.mocked(getPresignedUrl).mockClear();
});

const sqlRan = (re: RegExp) => query.mock.calls.some(([sql]) => re.test(String(sql)));

describe('authentication', () => {
  it('rejects unauthenticated requests', async () => {
    expect((await request(app).get(`/api/messages?channelId=${CHANNEL}`)).status).toBe(401);
    expect((await request(app).get(`/api/sse/${CHANNEL}`)).status).toBe(401);
  });
});

describe('channel reads are membership-checked', () => {
  it('hides another channel’s messages (404) without querying them', async () => {
    channelAccess({ [OTHER_CHANNEL]: { team: null } });
    const res = await agent.get(`/api/messages?channelId=${OTHER_CHANNEL}`);
    expect(res.status).toBe(404);
    expect(sqlRan(/FROM messages m\s+JOIN users/)).toBe(false);
  });

  it('treats a malformed channel id as not found instead of a database error', async () => {
    const res = await agent.get('/api/messages?channelId=not-a-uuid');
    expect(res.status).toBe(404);
    expect(query).not.toHaveBeenCalled();
  });

  it('hides a private channel from a team member who is not in it', async () => {
    channelAccess({ [CHANNEL]: { team: 'member', private: true, member: false } });
    expect((await agent.get(`/api/messages?channelId=${CHANNEL}`)).status).toBe(404);
    expect((await agent.get(`/api/presence/channel/${CHANNEL}`)).status).toBe(404);
    expect((await agent.get(`/api/files?channelId=${CHANNEL}`)).status).toBe(404);
  });

  it('clamps the page size and reports hasMore', async () => {
    channelAccess({ [CHANNEL]: { team: 'member' } });
    let limitParam: unknown;
    on(/FROM messages m\s+JOIN users u ON m.user_id = u.id\s+WHERE m.channel_id/, (params) => {
      limitParam = params[params.length - 1];
      return { rows: [{ id: 'm1' }, { id: 'm2' }] };
    });
    const res = await agent.get(`/api/messages?channelId=${CHANNEL}&limit=-5`);
    expect(res.status).toBe(200);
    expect(limitParam).toBe(2); // clamped to 1, plus one row to detect more
    expect(res.body.messages).toHaveLength(1);
    expect(res.body.hasMore).toBe(true);

    await agent.get(`/api/messages?channelId=${CHANNEL}&limit=100000`);
    expect(limitParam).toBe(101);
  });

  it('rejects a cursor from another channel', async () => {
    channelAccess({ [CHANNEL]: { team: 'member' } });
    const res = await agent.get(`/api/messages?channelId=${CHANNEL}&before=${MSG}`);
    expect(res.status).toBe(400);
  });
});

describe('SSE', () => {
  it('refuses to stream a channel the session user cannot read', async () => {
    channelAccess({ [CHANNEL]: { team: null } });
    const res = await agent.get(`/api/sse/${CHANNEL}`);
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/json/);
    expect(subscribeToChannel).not.toHaveBeenCalled();
  });
});

describe('writing messages', () => {
  it('refuses to post into a channel the caller cannot see', async () => {
    channelAccess({ [CHANNEL]: { team: null } });
    const res = await agent.post('/api/messages').send({ channelId: CHANNEL, content: 'hi' });
    expect(res.status).toBe(404);
    expect(sqlRan(/INSERT INTO messages/)).toBe(false);
  });

  it('refuses a thread reply whose parent is in another channel', async () => {
    channelAccess({ [CHANNEL]: { team: 'member' } });
    on(/SELECT channel_id, parent_message_id, deleted_at FROM messages/, [
      { channel_id: OTHER_CHANNEL, parent_message_id: null, deleted_at: null },
    ]);
    const res = await agent
      .post('/api/messages')
      .send({ channelId: CHANNEL, content: 'reply', parentMessageId: MSG });
    expect(res.status).toBe(400);
    expect(sqlRan(/INSERT INTO messages/)).toBe(false);
  });

  it('refuses a reply to a reply', async () => {
    channelAccess({ [CHANNEL]: { team: 'member' } });
    on(/SELECT channel_id, parent_message_id, deleted_at FROM messages/, [
      { channel_id: CHANNEL, parent_message_id: OTHER_CHANNEL, deleted_at: null },
    ]);
    const res = await agent
      .post('/api/messages')
      .send({ channelId: CHANNEL, content: 'reply', parentMessageId: MSG });
    expect(res.status).toBe(400);
  });

  it('answers a retried send from the database without broadcasting twice', async () => {
    channelAccess({ [CHANNEL]: { team: 'member' } });
    on(/INSERT INTO messages/, []); // ON CONFLICT DO NOTHING: already there
    on(/SELECT \* FROM messages WHERE id = \$1/, [
      { id: MSG, channel_id: CHANNEL, user_id: ALICE, parent_message_id: null, content: 'hi' },
    ]);
    on(/SELECT username, display_name, avatar_url FROM users/, [{ username: 'alice' }]);
    on(/COUNT\(\*\)::int AS n FROM messages/, [{ n: 0 }]);
    const res = await agent.post('/api/messages').send({ id: MSG, channelId: CHANNEL, content: 'hi' });
    expect(res.status).toBe(200);
    expect(res.body.message.id).toBe(MSG);
    expect(publishToChannel).not.toHaveBeenCalled();
  });

  it('refuses to reuse someone else’s message id', async () => {
    channelAccess({ [CHANNEL]: { team: 'member' } });
    on(/INSERT INTO messages/, []);
    on(/SELECT \* FROM messages WHERE id = \$1/, [
      { id: MSG, channel_id: CHANNEL, user_id: BOB, parent_message_id: null, content: 'secret' },
    ]);
    const res = await agent.post('/api/messages').send({ id: MSG, channelId: CHANNEL, content: 'hi' });
    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).not.toContain('secret');
  });
});

describe('editing and deleting', () => {
  const message = (userId: string) =>
    on(/SELECT id, channel_id, user_id, parent_message_id, deleted_at\s+FROM messages/, [
      { id: MSG, channel_id: CHANNEL, user_id: userId, parent_message_id: null, deleted_at: null },
    ]);

  it('forbids editing or deleting someone else’s message (403)', async () => {
    message(BOB);
    channelAccess({ [CHANNEL]: { team: 'member' } });
    expect((await agent.put(`/api/messages/${MSG}`).send({ content: 'mine now' })).status).toBe(403);
    expect((await agent.delete(`/api/messages/${MSG}`)).status).toBe(403);
    expect(sqlRan(/UPDATE messages/)).toBe(false);
  });

  it('hides a message in a channel the caller cannot see (404)', async () => {
    message(ALICE);
    channelAccess({ [CHANNEL]: { team: null } });
    expect((await agent.put(`/api/messages/${MSG}`).send({ content: 'x' })).status).toBe(404);
  });

  it('soft-deletes your own message and broadcasts it', async () => {
    message(ALICE);
    channelAccess({ [CHANNEL]: { team: 'member' } });
    on(/UPDATE messages SET content = '', deleted_at = NOW\(\)/, [
      { id: MSG, channel_id: CHANNEL, parent_message_id: null },
    ]);
    const res = await agent.delete(`/api/messages/${MSG}`);
    expect(res.status).toBe(200);
    expect(sqlRan(/DELETE FROM messages/)).toBe(false);
    expect(publishToChannel).toHaveBeenCalledWith(CHANNEL, 'message_deleted', expect.objectContaining({ id: MSG }));
  });
});

describe('reactions', () => {
  beforeEach(() => {
    on(/SELECT id, channel_id, user_id, parent_message_id, deleted_at\s+FROM messages/, [
      { id: MSG, channel_id: CHANNEL, user_id: BOB, parent_message_id: null, deleted_at: null },
    ]);
  });

  it('broadcasts only when the reaction was actually added', async () => {
    channelAccess({ [CHANNEL]: { team: 'member' } });
    on(/INSERT INTO message_reactions/, []); // duplicate: nothing inserted
    expect((await agent.post('/api/reactions').send({ messageId: MSG, emoji: '👍' })).status).toBe(200);
    expect(publishToChannel).not.toHaveBeenCalled();

    h.routes.unshift([/INSERT INTO message_reactions/, () => ({ rows: [{ id: 'r1' }] })]);
    expect((await agent.post('/api/reactions').send({ messageId: MSG, emoji: '👍' })).status).toBe(201);
    expect(publishToChannel).toHaveBeenCalledWith(CHANNEL, 'reaction_added', expect.anything());
  });

  it('refuses reactions on messages in channels the caller cannot see', async () => {
    channelAccess({ [CHANNEL]: { team: null } });
    expect((await agent.post('/api/reactions').send({ messageId: MSG, emoji: '👍' })).status).toBe(404);
    expect(sqlRan(/INSERT INTO message_reactions/)).toBe(false);
  });
});

describe('files', () => {
  it('does not mint a download URL for a file in a channel the caller cannot see', async () => {
    on(/SELECT \* FROM files WHERE id = \$1/, [{ id: FILE, channel_id: CHANNEL, storage_path: 'x' }]);
    channelAccess({ [CHANNEL]: { team: null } });
    const res = await agent.get(`/api/files/${FILE}/download`);
    expect(res.status).toBe(404);
    expect(getPresignedUrl).not.toHaveBeenCalled();
  });
});

describe('membership management', () => {
  it('does not let a plain member add people to the org, or an admin mint owners', async () => {
    on(/SELECT role FROM org_members WHERE org_id = \$1 AND user_id = \$2/, [{ role: 'member' }]);
    let res = await agent.post(`/api/organizations/${ORG}/members`).send({ userId: BOB });
    expect(res.status).toBe(403);

    h.routes = [];
    on(/SELECT role FROM org_members WHERE org_id = \$1 AND user_id = \$2/, [{ role: 'admin' }]);
    res = await agent.post(`/api/organizations/${ORG}/members`).send({ userId: BOB, role: 'owner' });
    expect(res.status).toBe(403);
    expect(sqlRan(/INSERT INTO org_members/)).toBe(false);
  });

  it('hides other tenants’ organizations and their teams (404)', async () => {
    expect((await agent.get(`/api/organizations/${ORG}`)).status).toBe(404);
    expect((await agent.get(`/api/teams?orgId=${ORG}`)).status).toBe(404);
    expect((await agent.post(`/api/organizations/${ORG}/members`).send({ userId: ALICE })).status).toBe(404);
  });

  it('does not let anyone join a private team they cannot see', async () => {
    on(/FROM teams t\s+LEFT JOIN org_members/, [
      { id: TEAM, org_id: ORG, is_private: true, org_role: 'member', team_role: null },
    ]);
    const res = await agent.post(`/api/teams/${TEAM}/members`).send({});
    expect(res.status).toBe(404);
    expect(sqlRan(/INSERT INTO team_members/)).toBe(false);
  });

  it('lets an org member join a public team, but not as an owner', async () => {
    on(/FROM teams t\s+LEFT JOIN org_members/, [
      { id: TEAM, org_id: ORG, is_private: false, org_role: 'member', team_role: null },
    ]);
    on(/SELECT 1 FROM org_members/, [{ '?column?': 1 }]);
    on(/INSERT INTO team_members/, [{ id: 'tm1' }]);
    expect((await agent.post(`/api/teams/${TEAM}/members`).send({ role: 'owner' })).status).toBe(403);
    expect((await agent.post(`/api/teams/${TEAM}/members`).send({})).status).toBe(201);
    // Joining also materializes membership of the team's public channels.
    expect(sqlRan(/INSERT INTO channel_members[\s\S]*is_private = false/)).toBe(true);
  });

  it('only adds people to a channel who are already on its team', async () => {
    channelAccess({ [CHANNEL]: { team: 'member', private: true, member: true } });
    const res = await agent.post(`/api/channels/${CHANNEL}/members`).send({ userId: BOB });
    expect(res.status).toBe(400);
    expect(sqlRan(/INSERT INTO channel_members/)).toBe(false);
  });

  it('evicts a removed member’s live streams', async () => {
    channelAccess({ [CHANNEL]: { team: 'member', private: true, member: true } });
    on(/DELETE FROM channel_members/, [{ id: 'cm1' }]);
    const res = await agent.delete(`/api/channels/${CHANNEL}/members/${ALICE}`);
    expect(res.status).toBe(200);
    expect(evictFromChannels).toHaveBeenCalledWith([CHANNEL], ALICE);
  });
});

describe('error handling', () => {
  it('answers malformed JSON with a JSON 400', async () => {
    const res = await agent
      .post('/api/messages')
      .set('Content-Type', 'application/json')
      .send('{"channelId":');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Malformed JSON/);
  });
});
