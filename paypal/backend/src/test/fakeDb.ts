import { vi } from 'vitest';

type Row = Record<string, unknown>;
type Handler = { match: RegExp; respond: (params: unknown[]) => { rows: Row[]; rowCount?: number } };

/**
 * A scripted stand-in for a pg PoolClient: each query is answered by the first
 * handler whose regex matches the SQL, and every call is recorded so tests can
 * assert what ran, in what order, with which parameters.
 */
export function createFakeClient() {
  const handlers: Handler[] = [];
  const calls: { sql: string; params: unknown[] }[] = [];

  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    const handler = handlers.find((h) => h.match.test(sql));
    if (!handler) return { rows: [], rowCount: 0 };
    const result = handler.respond(params);
    return { rowCount: result.rows.length, ...result };
  });

  return {
    query,
    release: vi.fn(),
    calls,
    /** Answers SQL matching `match`; later registrations take priority. */
    on(match: RegExp, respond: Handler['respond'] | Row[]) {
      handlers.unshift({
        match,
        respond: typeof respond === 'function' ? respond : () => ({ rows: respond }),
      });
      return this;
    },
    /** SQL text of every call, for order assertions. */
    sqlLog() {
      return calls.map((c) => c.sql.replace(/\s+/g, ' ').trim());
    },
  };
}

export type FakeClient = ReturnType<typeof createFakeClient>;
