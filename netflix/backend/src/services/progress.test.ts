import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * In-memory stand-in for the two tables the progress write touches. It honours
 * the statements recordProgress issues (insert-if-absent, SELECT ... FOR UPDATE,
 * UPDATE, history insert), which is enough to check the last-writer-wins rules
 * without PostgreSQL.
 */
interface Row {
  id: string;
  position_seconds: number;
  completed: boolean;
  client_updated_at: Date | null;
}
const table = new Map<string, Row>();
const history: unknown[][] = [];

const fakeClient = {
  query: vi.fn(async (sql: string, params: unknown[]) => {
    if (sql.includes('INSERT INTO viewing_progress')) {
      const key = `${params[0]}|${params[2] ?? params[1]}`;
      if (table.has(key)) return { rowCount: 0, rows: [] };
      table.set(key, {
        id: key,
        position_seconds: params[3] as number,
        completed: params[5] as boolean,
        client_updated_at: params[6] as Date,
      });
      return { rowCount: 1, rows: [{ id: key }] };
    }
    if (sql.includes('FOR UPDATE')) {
      const row = table.get(`${params[0]}|${params[1]}`);
      return { rowCount: row ? 1 : 0, rows: row ? [{ ...row }] : [] };
    }
    if (sql.includes('UPDATE viewing_progress')) {
      const row = table.get(params[0] as string)!;
      Object.assign(row, { position_seconds: params[2], completed: params[4], client_updated_at: params[5] });
      return { rowCount: 1, rows: [] };
    }
    if (sql.includes('INSERT INTO watch_history')) {
      history.push(params);
      return { rowCount: 1, rows: [] };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  }),
};

vi.mock('../db/index.js', () => ({
  transaction: vi.fn(async (fn: (client: unknown) => Promise<unknown>) => fn(fakeClient)),
}));

import { recordProgress, isProgressComplete, resolvePositionTimestamp, type ProgressWrite } from './progress.js';

const base: Omit<ProgressWrite, 'positionSeconds' | 'positionTimestamp'> = {
  profileId: 'p1',
  videoId: 'movie-1',
  episodeId: null,
  durationSeconds: 1000,
};
const at = (ms: number) => new Date(1_900_000_000_000 + ms);

describe('recordProgress (last writer wins by position timestamp)', () => {
  beforeEach(() => {
    table.clear();
    history.length = 0;
  });

  it('creates the row on the first report', async () => {
    const r = await recordProgress({ ...base, positionSeconds: 100, positionTimestamp: at(0) });
    expect(r).toMatchObject({ applied: true, completed: false, continueWatchingChanged: true });
  });

  it('ignores a late report observed before the stored one', async () => {
    await recordProgress({ ...base, positionSeconds: 600, positionTimestamp: at(20_000) });
    const late = await recordProgress({ ...base, positionSeconds: 300, positionTimestamp: at(10_000) });
    expect(late).toMatchObject({ applied: false, positionSeconds: 600 });
    expect(table.get('p1|movie-1')!.position_seconds).toBe(600);
  });

  it('applies a newer report even when it moves the position backwards (a seek)', async () => {
    await recordProgress({ ...base, positionSeconds: 600, positionTimestamp: at(0) });
    const seek = await recordProgress({ ...base, positionSeconds: 120, positionTimestamp: at(5_000) });
    expect(seek).toMatchObject({ applied: true, positionSeconds: 120 });
  });

  it('treats a retry with the same timestamp as a no-op', async () => {
    const write = { ...base, positionSeconds: 990, positionTimestamp: at(0) };
    const first = await recordProgress(write);
    const retry = await recordProgress(write);
    expect(first).toMatchObject({ applied: true, completed: true, historyRecorded: true });
    expect(retry).toMatchObject({ applied: false, historyRecorded: false });
    expect(history).toHaveLength(1);
  });

  it('records one view per transition to completed', async () => {
    await recordProgress({ ...base, positionSeconds: 500, positionTimestamp: at(0) });
    const done = await recordProgress({ ...base, positionSeconds: 960, positionTimestamp: at(1_000) });
    const credits = await recordProgress({ ...base, positionSeconds: 990, positionTimestamp: at(2_000) });
    expect(done).toMatchObject({ completed: true, historyRecorded: true, continueWatchingChanged: true });
    expect(credits).toMatchObject({ applied: true, historyRecorded: false, continueWatchingChanged: false });
    expect(history).toHaveLength(1);

    // Rewatch: back to the start, then finish again -> a second view.
    await recordProgress({ ...base, positionSeconds: 10, positionTimestamp: at(3_000) });
    await recordProgress({ ...base, positionSeconds: 980, positionTimestamp: at(4_000) });
    expect(history).toHaveLength(2);
  });

  it('keys episodes by episode id and records the series as the title', async () => {
    await recordProgress({
      ...base,
      videoId: 'series-1',
      episodeId: 'ep-3',
      positionSeconds: 990,
      positionTimestamp: at(0),
    });
    expect(table.has('p1|ep-3')).toBe(true);
    expect(history[0]).toEqual(['p1', 'series-1', 'ep-3']);
  });
});

describe('progress helpers', () => {
  it('completes only past 95%', () => {
    expect(isProgressComplete(950, 1000)).toBe(false);
    expect(isProgressComplete(951, 1000)).toBe(true);
    expect(isProgressComplete(10, 0)).toBe(false);
  });

  it('defaults a missing client timestamp to server time and clamps a fast clock', () => {
    const nowMs = 1_900_000_000_000;
    expect(resolvePositionTimestamp(undefined, nowMs).getTime()).toBe(nowMs);
    expect(resolvePositionTimestamp(nowMs - 5_000, nowMs).getTime()).toBe(nowMs - 5_000);
    expect(resolvePositionTimestamp(nowMs + 3_600_000, nowMs, 60_000).getTime()).toBe(nowMs + 60_000);
  });
});
