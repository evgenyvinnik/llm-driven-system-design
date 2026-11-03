import crypto from 'crypto';
import pg from 'pg';
import Cursor from 'pg-cursor';
import { config as appConfig } from '../config/index.js';
import { pool as metadataPool } from './db.js';
import { logger } from './logger.js';
import { activeConnections } from './metrics.js';
import { createCircuitBreaker } from './circuitBreaker.js';
import { ApiError } from './errors.js';

/**
 * Every query against a project's (target) database goes through this module.
 * It owns four guarantees the routes rely on:
 *
 * 1. Pools are keyed by project AND a fingerprint of the connection settings, so
 *    a config change (from any route, on any API instance) builds a new pool
 *    instead of reusing one that still points at the old database.
 * 2. A target can never be the dashboard's own metadata server. Each new pool
 *    compares the server it reached with the metadata server before it is used.
 * 3. A per-project circuit breaker counts only "target unreachable" errors, so a
 *    dead database fails fast while syntax errors and constraint violations
 *    never trip it.
 * 4. User SQL runs one statement at a time with a statement timeout, a row cap,
 *    a READ ONLY transaction for viewers, and a session reset afterwards, so
 *    nothing a user does (BEGIN, SET, advisory locks, temp tables) leaks into
 *    the pooled connection the next request receives.
 */

export interface ConnectionConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

export interface QueryOutput {
  rows: Record<string, unknown>[];
  fields: { name: string; dataTypeID: number }[];
  rowCount: number;
}

export interface UserSqlOutput extends QueryOutput {
  command: string | null;
  truncated: boolean;
}

export const STATEMENT_TIMEOUT_MS = 30_000;
export const MAX_RESULT_ROWS = 1000;
const POOL_MAX = 5;

/** The target answered with a connection-level failure or is behind an open circuit. */
export class TargetUnavailableError extends ApiError {
  constructor(message: string) {
    super(503, message);
    this.name = 'TargetUnavailableError';
  }
}

/** The target reached is the dashboard's own metadata server. */
export class MetadataTargetError extends ApiError {
  constructor() {
    super(
      400,
      "This connection points at the dashboard's own metadata database. Projects must use a separate PostgreSQL server.",
    );
    this.name = 'MetadataTargetError';
  }
}

/** A statement the target rejected (syntax, constraint, permission, timeout): the user's error to see. */
export class TargetQueryError extends ApiError {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(400, message, { code });
    this.name = 'TargetQueryError';
  }
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

const NETWORK_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'EPIPE',
]);

/**
 * True when the error says the target can't be used at all (network, auth,
 * missing database, server shutting down) rather than that a statement failed.
 */
export function isTargetUnavailable(err: unknown): boolean {
  if (err instanceof TargetUnavailableError) return true;
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string') {
    if (NETWORK_ERROR_CODES.has(code)) return true;
    // 08 connection exception, 28 invalid authorization, 3D000 no such database,
    // 53300 too many connections, 57P01-57P03 admin shutdown / crash / starting up
    if (/^(08|28)/.test(code) || code === '3D000' || code === '53300' || /^57P0[123]$/.test(code)) return true;
  }
  const message = (err as { message?: unknown }).message;
  return typeof message === 'string' && /timeout exceeded when trying to connect|Connection terminated/i.test(message);
}

function isSqlState(err: unknown): err is Error & { code: string } {
  const code = (err as { code?: unknown } | null)?.code;
  return err instanceof Error && typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code);
}

/** Converts raw driver / breaker errors into ApiErrors with the right status. */
function toApiError(err: unknown): unknown {
  if (err instanceof ApiError) return err;
  const code = (err as { code?: unknown })?.code;
  if (code === 'EOPENBREAKER') {
    return new TargetUnavailableError(
      'Target database is unavailable: repeated connection failures opened the circuit breaker. Retrying in up to 30 seconds.',
    );
  }
  if (code === 'ETIMEDOUT' && err instanceof Error && err.message.startsWith('Timed out after')) {
    return new TargetUnavailableError('Target database did not respond in time');
  }
  if (isTargetUnavailable(err)) {
    const detail = err instanceof Error ? err.message : 'connection failed';
    return new TargetUnavailableError(`Cannot reach the target database: ${detail}`);
  }
  if (isSqlState(err)) {
    if (err.code === '42601' && /multiple commands/i.test(err.message)) {
      return new TargetQueryError('Run one statement at a time (or wrap several in a DO block).', err.code);
    }
    return new TargetQueryError(err.message, err.code);
  }
  return err;
}

// ---------------------------------------------------------------------------
// Metadata-server guard
// ---------------------------------------------------------------------------

function normalizeHost(host: string): string {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h === '::1' || h === '::' || h === '0.0.0.0' || /^127\./.test(h)) return 'loopback';
  return h;
}

/**
 * Cheap save-time check: does host:port name the metadata server's own address?
 * Catches the obvious case (`localhost:5432`) with a clear 400 before anything
 * is stored. Aliases it can't see (another hostname, a port forward) are caught
 * by `assertNotMetadataServer` when a connection is actually made.
 */
export function pointsAtMetadataServer(host: string, port: number): boolean {
  try {
    const meta = new URL(appConfig.database.url);
    const metaPort = meta.port ? parseInt(meta.port, 10) : 5432;
    return normalizeHost(host) === normalizeHost(meta.hostname) && port === metaPort;
  } catch {
    return false;
  }
}

// The postmaster start time (to the microsecond) identifies a running server
// instance, is readable by any role, and doesn't depend on how it was reached.
const SERVER_ID_SQL = 'SELECT extract(epoch FROM pg_postmaster_start_time())::text AS server_id';

/** Throws MetadataTargetError if `client` is connected to the metadata server. */
export async function assertNotMetadataServer(client: pg.ClientBase): Promise<void> {
  // Not cached: a metadata restart changes its start time, and a stale value would open the hole again.
  const [target, meta] = await Promise.all([client.query(SERVER_ID_SQL), metadataPool.query(SERVER_ID_SQL)]);
  if (target.rows[0]?.server_id === meta.rows[0]?.server_id) {
    throw new MetadataTargetError();
  }
}

// ---------------------------------------------------------------------------
// Pools and breakers
// ---------------------------------------------------------------------------

interface PoolEntry {
  pool: pg.Pool;
  fingerprint: string;
  verified: Promise<void> | null;
}

const targetPools = new Map<string, PoolEntry>();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const breakers = new Map<string, any>();

/** Discrete fields, never a URL: a password containing `@` or `/` can't rewrite the host. */
function connectionOptions(config: ConnectionConfig): pg.ClientConfig {
  return {
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    application_name: 'supabase-dashboard',
  };
}

function fingerprintOf(config: ConnectionConfig): string {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify([config.host, config.port, config.database, config.user, config.password]))
    .digest('hex');
}

function retirePool(projectId: string, entry: PoolEntry): void {
  // Only the entry currently registered may be removed: a late error event from a
  // retired pool must not evict (and leak) the replacement built after it.
  if (targetPools.get(projectId) !== entry) return;
  targetPools.delete(projectId);
  activeConnections.dec();
  entry.pool.end().catch(() => {});
}

function getPoolEntry(projectId: string, config: ConnectionConfig): PoolEntry {
  const fingerprint = fingerprintOf(config);
  const existing = targetPools.get(projectId);
  if (existing && existing.fingerprint === fingerprint) return existing;
  if (existing) retirePool(projectId, existing);

  const pool = new pg.Pool({
    ...connectionOptions(config),
    max: POOL_MAX,
    idleTimeoutMillis: 60000,
    connectionTimeoutMillis: 5000,
    // Session defaults restored by DISCARD ALL after every user statement.
    statement_timeout: STATEMENT_TIMEOUT_MS,
    idle_in_transaction_session_timeout: 60000,
  });
  const entry: PoolEntry = { pool, fingerprint, verified: null };

  pool.on('error', (err) => {
    logger.error({ err, projectId }, 'Target pool error');
    retirePool(projectId, entry);
  });

  targetPools.set(projectId, entry);
  activeConnections.inc();
  logger.info({ projectId, host: config.host, database: config.database }, 'Target pool created');
  return entry;
}

/** Returns or creates the cached pool for a project's target database. */
export function getTargetPool(projectId: string, config: ConnectionConfig): pg.Pool {
  return getPoolEntry(projectId, config).pool;
}

function breakerFor(projectId: string) {
  let breaker = breakers.get(projectId);
  if (!breaker) {
    breaker = createCircuitBreaker((op: unknown) => (op as () => Promise<unknown>)(), `target:${projectId}`, {
      // statement_timeout bounds healthy queries; this only catches a target that stops answering.
      timeout: STATEMENT_TIMEOUT_MS + 5000,
      volumeThreshold: 3,
      errorFilter: (err) => !isTargetUnavailable(err),
    });
    breakers.set(projectId, breaker);
  }
  return breaker;
}

async function verifyEntry(projectId: string, entry: PoolEntry, client: pg.PoolClient): Promise<void> {
  if (!entry.verified) {
    entry.verified = assertNotMetadataServer(client).catch((err) => {
      if (err instanceof MetadataTargetError) {
        retirePool(projectId, entry);
      } else {
        entry.verified = null; // transient: check again on the next request
      }
      throw err;
    });
  }
  await entry.verified;
}

/**
 * Checks out a client for one project's target, runs `fn`, and releases it.
 * The connection is destroyed instead of returned when it may be unusable or
 * still carry session state.
 */
export async function withTargetClient<T>(
  projectId: string,
  config: ConnectionConfig,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const run = async (): Promise<T> => {
    const entry = getPoolEntry(projectId, config);
    const client = await entry.pool.connect();
    let discard = false;
    try {
      await verifyEntry(projectId, entry, client);
      return await fn(client);
    } catch (err) {
      discard =
        isTargetUnavailable(err) ||
        Boolean((err as { discardConnection?: boolean })?.discardConnection) ||
        client.getTransactionStatus() !== 'I';
      throw err;
    } finally {
      client.release(discard ? true : undefined);
    }
  };
  try {
    return (await breakerFor(projectId).fire(run)) as T;
  } catch (err) {
    throw toApiError(err);
  }
}

/**
 * Runs one dashboard-generated statement with bound values. `queryMode:
 * 'extended'` sends it as a prepared statement, which Postgres refuses to split
 * into several commands, so nothing in a value or identifier can append a second
 * statement.
 */
export async function runStatement(client: pg.ClientBase, sql: string, params: unknown[] = []): Promise<QueryOutput> {
  const result = await client.query({ text: sql, values: params, queryMode: 'extended' } as pg.QueryConfig);
  return {
    rows: result.rows,
    fields: (result.fields ?? []).map((f) => ({ name: f.name, dataTypeID: f.dataTypeID })),
    rowCount: result.rowCount ?? 0,
  };
}

/** Executes one dashboard-generated statement (DDL, row CRUD) against a project's target database. */
export async function executeQuery(
  projectId: string,
  config: ConnectionConfig,
  sql: string,
  params: unknown[] = [],
): Promise<QueryOutput> {
  return withTargetClient(projectId, config, (client) => runStatement(client, sql, params));
}

function readCursor(client: pg.ClientBase, sql: string, maxRows: number): Promise<UserSqlOutput> {
  const cursor = client.query(new Cursor(sql));
  return new Promise((resolve, reject) => {
    // Ask for one row more than we return: getting it means the result was cut off,
    // without ever buffering the rest of a large table in the API process.
    cursor.read(maxRows + 1, (err, rows, result) => {
      if (err) {
        reject(err);
        return;
      }
      const truncated = rows.length > maxRows;
      const output: UserSqlOutput = {
        rows: truncated ? rows.slice(0, maxRows) : rows,
        fields: (result.fields ?? []).map((f) => ({ name: f.name, dataTypeID: f.dataTypeID })),
        rowCount: truncated ? maxRows : (result.rowCount ?? rows.length),
        command: result.command ?? null,
        truncated,
      };
      if (!truncated) {
        resolve(output);
        return;
      }
      cursor.close().then(() => resolve(output), reject);
    });
  });
}

/** Rolls back anything still open and clears session state (SET, temp tables, locks, LISTEN). */
async function resetSession(client: pg.ClientBase): Promise<void> {
  try {
    if (client.getTransactionStatus() !== 'I') await client.query('ROLLBACK');
    await client.query('DISCARD ALL');
  } catch (err) {
    throw Object.assign(err instanceof Error ? err : new Error(String(err)), { discardConnection: true });
  }
}

/**
 * Runs SQL typed into the SQL editor.
 *
 * - One statement per request (extended protocol). Multi-statement work runs as
 *   a single `DO` block, which is atomic.
 * - `statement_timeout` (30s) is a session default; any `SET` the user issues is
 *   undone by DISCARD ALL before the connection goes back to the pool.
 * - At most `maxRows` rows are read from a cursor; `truncated` says there were more.
 * - `readOnly` (viewers) wraps the statement in BEGIN READ ONLY, so Postgres
 *   rejects writes and DDL. This is a guard, not a privilege boundary: the role
 *   in the project's credentials still decides what server-side functions can do.
 */
export async function executeUserSql(
  projectId: string,
  config: ConnectionConfig,
  sql: string,
  opts: { readOnly: boolean; maxRows?: number },
): Promise<UserSqlOutput> {
  const maxRows = opts.maxRows ?? MAX_RESULT_ROWS;
  return withTargetClient(projectId, config, async (client) => {
    let output: UserSqlOutput | undefined;
    let failure: unknown;
    try {
      if (opts.readOnly) {
        await client.query('BEGIN READ ONLY');
        // Taking a snapshot first means the user's statement can no longer switch
        // the transaction back with SET TRANSACTION READ WRITE.
        await client.query('SELECT 1');
      }
      output = await readCursor(client, sql, maxRows);
      if (!opts.readOnly && client.getTransactionStatus() !== 'I') {
        failure = new ApiError(
          400,
          'Transactions cannot span requests: each run gets a fresh session, so this transaction was rolled back. ' +
            'Wrap multi-statement work in a single DO block instead.',
        );
      }
    } catch (err) {
      failure = err;
    }
    await resetSession(client);
    if (failure) throw failure;
    return output as UserSqlOutput;
  });
}

/** Tests connectivity with a temporary client, refusing the metadata server. */
export async function testConnection(config: ConnectionConfig): Promise<{ success: boolean; error?: string }> {
  const client = new pg.Client({ ...connectionOptions(config), connectionTimeoutMillis: 5000 });
  try {
    await client.connect();
    await assertNotMetadataServer(client);
    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Connection failed';
    return { success: false, error: message };
  } finally {
    await client.end().catch(() => {});
  }
}

/** Closes the breaker after an explicit successful connection test. */
export function resetCircuit(projectId: string): void {
  breakers.get(projectId)?.close();
}

/** Closes all cached target database pools during graceful shutdown. */
export async function cleanupTargetPools(): Promise<void> {
  for (const [projectId, entry] of targetPools) {
    try {
      await entry.pool.end();
      logger.info({ projectId }, 'Target pool closed');
    } catch (err) {
      logger.error({ err, projectId }, 'Error closing target pool');
    }
  }
  targetPools.clear();
  for (const breaker of breakers.values()) breaker.shutdown?.();
  breakers.clear();
  activeConnections.set(0);
}

/** Drops a project's pool and breaker (connection settings changed, or the project was deleted). */
export function removeTargetPool(projectId: string): void {
  const entry = targetPools.get(projectId);
  if (entry) retirePool(projectId, entry);
  breakers.get(projectId)?.shutdown?.();
  breakers.delete(projectId);
}
