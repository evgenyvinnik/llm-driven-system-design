/**
 * @fileoverview Operator accounts: a `users` table with roles.
 *
 * - **Roles:** `admin` (can change crawler state and manage users) and `user`
 *   (read-only operator; reads are public anyway, but a named account gets a
 *   higher rate limit and shows up in logs).
 * - **Passwords:** PBKDF2-HMAC-SHA512, encoded as
 *   `pbkdf2_sha512$<iterations>$<salt>$<hash>` so the iteration count can be
 *   raised later without invalidating stored hashes. Hashing uses the async
 *   `crypto.pbkdf2` (libuv threadpool): at 210k iterations the sync variant
 *   blocks the API's event loop for ~150-200ms per login.
 * - **Session revocation:** each user has a `session_version`. Sessions store
 *   the version they were issued with; disabling a user, changing their role,
 *   changing their password, or an explicit "sign out everywhere" bumps it,
 *   and every authenticated request re-checks it, so existing sessions die
 *   immediately.
 * - **Auth-state cache:** that per-request check reads a small Redis record
 *   (`crawler:auth:user:{id}`: username, role, disabled, version) instead of
 *   Postgres. Every mutation here writes the new state through to Redis after
 *   its commit, using a Lua script that only overwrites an *older* version -
 *   `session_version` increases on every change, so a slow reader that loaded
 *   stale data from Postgres can't clobber a fresher revocation. Deletes write
 *   a tombstone for the same reason. Edit users through this module (or the
 *   API), not raw SQL: a direct UPDATE isn't seen until the cache entry expires.
 * - **Last-admin guard:** demoting, disabling, or deleting the last active
 *   admin is refused. The check runs in a transaction that row-locks every
 *   active admin, so two concurrent demotions can't both pass it.
 * - **Bootstrap / break-glass:** on startup, if no active admin exists, one is
 *   created (or restored) from ADMIN_USERNAME / ADMIN_PASSWORD.
 *
 * @module services/users
 */

import crypto from 'crypto';
import { promisify } from 'util';
import type { PoolClient } from 'pg';
import { pool } from '../models/database.js';
import { redis, REDIS_KEYS } from '../models/redis.js';
import { config } from '../config.js';
import { logger } from '../shared/logger.js';
import { authCacheCounter } from '../shared/metrics.js';
import { record as recordAudit } from './audit.js';

const pbkdf2 = promisify(crypto.pbkdf2);

/** PBKDF2 iterations for new hashes (OWASP 2023 guidance for PBKDF2-HMAC-SHA512). */
const PBKDF2_ITERATIONS = 210_000;

export type Role = 'admin' | 'user';
export const ROLES: readonly Role[] = ['admin', 'user'];

export interface User {
  id: number;
  username: string;
  role: Role;
  disabled: boolean;
  sessionVersion: number;
  createdAt: Date;
  lastLoginAt: Date | null;
}

/** Validation / business-rule failure with an HTTP status for the route layer. */
export class UserError extends Error {
  constructor(
    message: string,
    public readonly status: 400 | 404 | 409
  ) {
    super(message);
    this.name = 'UserError';
  }
}

interface UserRow {
  id: number;
  username: string;
  password_hash: string;
  role: Role;
  disabled: boolean;
  session_version: number;
  created_at: Date;
  last_login_at: Date | null;
}

function toUser(row: UserRow): User {
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    disabled: row.disabled,
    sessionVersion: row.session_version,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at,
  };
}

// ---------------------------------------------------------------------------
// Auth-state cache (what every protected request checks)
// ---------------------------------------------------------------------------

/** The subset of a user that authorization needs. */
export interface AuthState {
  id: number;
  username: string;
  role: Role;
  disabled: boolean;
  sessionVersion: number;
}

const AUTH_CACHE_TTL_SECONDS = 600;
/** Version used for tombstones: newer than any real session_version. */
const TOMBSTONE_VERSION = Number.MAX_SAFE_INTEGER;

/**
 * SET key value EX ttl, unless the cached entry already has an equal or newer
 * version. ARGV: [json, version, ttl]. Returns 1 if written.
 */
const SET_IF_NEWER = `
local current = redis.call('GET', KEYS[1])
if current then
  local ok, decoded = pcall(cjson.decode, current)
  if ok and decoded.v and tonumber(decoded.v) >= tonumber(ARGV[2]) then
    return 0
  end
end
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[3])
return 1
`;

async function writeAuthState(id: number, state: Omit<AuthState, 'id'> | null, version: number): Promise<void> {
  const payload = state
    ? JSON.stringify({ u: state.username, r: state.role, d: state.disabled, v: version })
    : JSON.stringify({ deleted: true, v: version });
  await redis.eval(SET_IF_NEWER, 1, REDIS_KEYS.AUTH_USER(id), payload, version, AUTH_CACHE_TTL_SECONDS);
}

/** Write-through after a committed change (or a DB read on cache miss). */
export async function cacheAuthState(user: AuthState | User): Promise<void> {
  try {
    await writeAuthState(user.id, user, user.sessionVersion);
  } catch (error) {
    // If this fails the entry may be stale until TTL; drop it so the next
    // request falls back to Postgres instead.
    logger.error({ err: error, userId: user.id }, 'Auth cache write failed; evicting');
    await redis.del(REDIS_KEYS.AUTH_USER(user.id)).catch(() => undefined);
  }
}

/**
 * Authorization state for a session's user: Redis first, Postgres on miss.
 * Returns null if the user doesn't exist (or was deleted).
 */
export async function getAuthState(id: number): Promise<AuthState | null> {
  try {
    const cached = await redis.get(REDIS_KEYS.AUTH_USER(id));
    if (cached) {
      const c = JSON.parse(cached);
      authCacheCounter.labels('hit').inc();
      if (c.deleted) return null;
      return { id, username: c.u, role: c.r, disabled: c.d, sessionVersion: Number(c.v) };
    }
  } catch (error) {
    logger.warn({ err: error, userId: id }, 'Auth cache read failed; using Postgres');
  }

  authCacheCounter.labels('miss').inc();
  const user = await getUserById(id);
  if (!user) return null;
  await cacheAuthState(user);
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    disabled: user.disabled,
    sessionVersion: user.sessionVersion,
  };
}

// ---------------------------------------------------------------------------
// Passwords
// ---------------------------------------------------------------------------

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS, 64, 'sha512');
  return `pbkdf2_sha512$${PBKDF2_ITERATIONS}$${salt}$${hash.toString('hex')}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [scheme, iterStr, salt, hashHex] = encoded.split('$');
  const iterations = parseInt(iterStr, 10);
  if (scheme !== 'pbkdf2_sha512' || !iterations || !salt || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = await pbkdf2(password, salt, iterations, expected.length, 'sha512');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

/** A real hash of a random password: verifying against it costs the same as a real user. */
let dummyHash: Promise<string> | null = null;
function getDummyHash(): Promise<string> {
  dummyHash ??= hashPassword(crypto.randomBytes(16).toString('hex'));
  return dummyHash;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,63}$/;

export function normalizeUsername(raw: unknown): string {
  if (typeof raw !== 'string') throw new UserError('username is required', 400);
  const username = raw.trim().toLowerCase();
  if (!USERNAME_RE.test(username)) {
    throw new UserError(
      'username must be 3-64 characters: letters, digits, ".", "_" or "-", starting with a letter or digit',
      400
    );
  }
  return username;
}

export function validatePassword(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length < 8) {
    throw new UserError('password must be at least 8 characters', 400);
  }
  if (raw.length > 256) throw new UserError('password must be at most 256 characters', 400);
  return raw;
}

export function validateRole(raw: unknown): Role {
  if (!ROLES.includes(raw as Role)) throw new UserError(`role must be one of: ${ROLES.join(', ')}`, 400);
  return raw as Role;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

const USER_COLUMNS =
  'id, username, password_hash, role, disabled, session_version, created_at, last_login_at';

export async function getUserById(id: number): Promise<User | null> {
  const result = await pool.query<UserRow>(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1`, [id]);
  return result.rows[0] ? toUser(result.rows[0]) : null;
}

export async function listUsers(): Promise<User[]> {
  const result = await pool.query<UserRow>(`SELECT ${USER_COLUMNS} FROM users ORDER BY username`);
  return result.rows.map(toUser);
}

/**
 * Verifies credentials. Unknown and disabled users cost the same hashing time
 * as real ones, so response time doesn't reveal which usernames exist.
 */
export async function authenticate(username: unknown, password: unknown): Promise<User | null> {
  if (typeof username !== 'string' || typeof password !== 'string') return null;
  const result = await pool.query<UserRow>(
    `SELECT ${USER_COLUMNS} FROM users WHERE username = $1`,
    [username.trim().toLowerCase()]
  );
  const row = result.rows[0];
  const ok = await verifyPassword(password, row?.password_hash ?? (await getDummyHash()));
  if (!row || !ok || row.disabled) return null;

  await pool.query('UPDATE users SET last_login_at = NOW() WHERE id = $1', [row.id]);
  const user = toUser(row);
  await cacheAuthState(user); // warm: the next request is authorized from Redis
  return user;
}

export async function createUser(input: {
  username: unknown;
  password: unknown;
  role: unknown;
}): Promise<User> {
  const username = normalizeUsername(input.username);
  const password = validatePassword(input.password);
  const role = validateRole(input.role ?? 'user');
  const passwordHash = await hashPassword(password);
  try {
    const result = await pool.query<UserRow>(
      `INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3)
       RETURNING ${USER_COLUMNS}`,
      [username, passwordHash, role]
    );
    return toUser(result.rows[0]);
  } catch (error) {
    if ((error as { code?: string }).code === '23505') {
      throw new UserError(`username "${username}" already exists`, 409);
    }
    throw error;
  }
}

/**
 * Runs `fn` in a transaction that holds row locks on every active admin, and
 * passes the set of their ids. Used to enforce the last-admin rule safely.
 */
async function withAdminLock<T>(fn: (client: PoolClient, activeAdminIds: Set<number>) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const admins = await client.query<{ id: number }>(
      `SELECT id FROM users WHERE role = 'admin' AND disabled = false FOR UPDATE`
    );
    const result = await fn(client, new Set(admins.rows.map((r) => r.id)));
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function assertNotLastAdmin(id: number, activeAdminIds: Set<number>, action: string): void {
  if (activeAdminIds.has(id) && activeAdminIds.size === 1) {
    throw new UserError(`Cannot ${action} the last active admin`, 409);
  }
}

/**
 * Updates role / disabled / password. Any of these bumps `session_version`,
 * which revokes the user's existing sessions.
 */
export async function updateUser(
  id: number,
  changes: { role?: unknown; disabled?: unknown; password?: unknown }
): Promise<User> {
  const role = changes.role !== undefined ? validateRole(changes.role) : undefined;
  if (changes.disabled !== undefined && typeof changes.disabled !== 'boolean') {
    throw new UserError('disabled must be a boolean', 400);
  }
  const disabled = changes.disabled as boolean | undefined;
  const passwordHash =
    changes.password !== undefined ? await hashPassword(validatePassword(changes.password)) : undefined;

  if (role === undefined && disabled === undefined && passwordHash === undefined) {
    throw new UserError('No changes provided', 400);
  }

  const updated = await withAdminLock(async (client, activeAdminIds) => {
    if ((role !== undefined && role !== 'admin') || disabled === true) {
      assertNotLastAdmin(id, activeAdminIds, role !== undefined && role !== 'admin' ? 'demote' : 'disable');
    }

    const sets: string[] = ['session_version = session_version + 1', 'updated_at = NOW()'];
    const params: (string | number | boolean)[] = [id];
    if (role !== undefined) sets.push(`role = $${params.push(role)}`);
    if (disabled !== undefined) sets.push(`disabled = $${params.push(disabled)}`);
    if (passwordHash !== undefined) sets.push(`password_hash = $${params.push(passwordHash)}`);

    const result = await client.query<UserRow>(
      `UPDATE users SET ${sets.join(', ')} WHERE id = $1 RETURNING ${USER_COLUMNS}`,
      params
    );
    if (result.rowCount === 0) throw new UserError('User not found', 404);
    return toUser(result.rows[0]);
  });
  // After COMMIT: publishing before it could expose a change that rolls back
  await cacheAuthState(updated);
  return updated;
}

export async function deleteUser(id: number): Promise<void> {
  await withAdminLock(async (client, activeAdminIds) => {
    assertNotLastAdmin(id, activeAdminIds, 'delete');
    const result = await client.query('DELETE FROM users WHERE id = $1', [id]);
    if (result.rowCount === 0) throw new UserError('User not found', 404);
  });
  // Tombstone, not DEL: a reader that loaded the row just before the delete
  // could otherwise re-cache it.
  await writeAuthState(id, null, TOMBSTONE_VERSION).catch(async (error) => {
    logger.error({ err: error, userId: id }, 'Auth tombstone write failed; evicting');
    await redis.del(REDIS_KEYS.AUTH_USER(id)).catch(() => undefined);
  });
}

/**
 * Signs a user out everywhere (bumps session_version).
 * @returns The updated user
 */
export async function revokeSessions(id: number): Promise<User> {
  const result = await pool.query<UserRow>(
    `UPDATE users SET session_version = session_version + 1, updated_at = NOW()
     WHERE id = $1 RETURNING ${USER_COLUMNS}`,
    [id]
  );
  if (result.rowCount === 0) throw new UserError('User not found', 404);
  const user = toUser(result.rows[0]);
  await cacheAuthState(user);
  return user;
}

/**
 * Changes a user's own password after verifying the current one.
 * @returns The updated user (new session_version)
 */
export async function changeOwnPassword(
  id: number,
  currentPassword: unknown,
  newPassword: unknown
): Promise<User> {
  const result = await pool.query<UserRow>(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1`, [id]);
  const row = result.rows[0];
  if (!row) throw new UserError('User not found', 404);
  if (typeof currentPassword !== 'string' || !(await verifyPassword(currentPassword, row.password_hash))) {
    throw new UserError('Current password is incorrect', 400);
  }
  const next = validatePassword(newPassword);
  const updated = await pool.query<UserRow>(
    `UPDATE users SET password_hash = $2, session_version = session_version + 1, updated_at = NOW()
     WHERE id = $1 RETURNING ${USER_COLUMNS}`,
    [id, await hashPassword(next)]
  );
  const user = toUser(updated.rows[0]);
  await cacheAuthState(user);
  return user;
}

/**
 * Ensures at least one active admin exists.
 *
 * If none does (fresh install, or every admin was removed or disabled), the
 * account named ADMIN_USERNAME is created - or restored to an active admin with
 * ADMIN_PASSWORD if it exists - so an operator can always recover access by
 * restarting the API with credentials in the environment.
 */
export async function ensureBootstrapAdmin(): Promise<void> {
  const active = await pool.query(
    `SELECT 1 FROM users WHERE role = 'admin' AND disabled = false LIMIT 1`
  );
  if (active.rows.length > 0) return;

  if (config.nodeEnv === 'production' && !process.env.ADMIN_PASSWORD) {
    throw new Error('No active admin exists; set ADMIN_PASSWORD to bootstrap one');
  }
  const username = normalizeUsername(process.env.ADMIN_USERNAME || 'admin');
  const passwordHash = await hashPassword(process.env.ADMIN_PASSWORD || 'password123');

  const result = await pool.query<UserRow>(
    `INSERT INTO users (username, password_hash, role) VALUES ($1, $2, 'admin')
     ON CONFLICT (username) DO UPDATE SET
       password_hash = EXCLUDED.password_hash,
       role = 'admin',
       disabled = false,
       session_version = users.session_version + 1,
       updated_at = NOW()
     RETURNING ${USER_COLUMNS}`,
    [username, passwordHash]
  );
  const user = toUser(result.rows[0]);
  await cacheAuthState(user);
  logger.warn({ username }, 'No active admin found; bootstrapped admin account from environment');
  await recordAudit({
    action: 'system.admin.bootstrap',
    targetType: 'user',
    targetId: user.id,
    details: { username, restored: user.sessionVersion > 1 },
  });
}
