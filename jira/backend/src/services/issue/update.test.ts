import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Issue, User } from '../../types/index.js';

const mocks = vi.hoisted(() => ({ clientQuery: vi.fn(), afterIssueCommitted: vi.fn() }));

vi.mock('../../config/database.js', () => ({
  query: vi.fn(),
  withTransaction: async (callback: (client: unknown) => Promise<unknown>) =>
    callback({ query: mocks.clientQuery }),
}));
vi.mock('../../config/logger.js', () => {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { logger: { ...log, child: () => log } };
});
vi.mock('./afterCommit.js', () => ({ afterIssueCommitted: mocks.afterIssueCommitted }));

import { diffIssue, updateIssue } from './update.js';

const alice = { id: 'u-alice', role: 'user' } as User;

const current = {
  id: 7,
  key: 'DEMO-7',
  project_id: 'p-1',
  summary: 'Old summary',
  description: null,
  priority: 'medium',
  assignee_id: null,
  story_points: 3,
  labels: ['ui'],
  custom_fields: { severity: 'low' },
  version: 4,
} as unknown as Issue;

beforeEach(() => vi.clearAllMocks());

describe('diffIssue', () => {
  it('lists only fields that actually change', () => {
    const changes = diffIssue(current, { summary: 'Old summary', priority: 'high', labels: ['ui'] });
    expect(changes).toEqual([{ column: 'priority', label: 'priority', oldValue: 'medium', newValue: 'high' }]);
  });

  it('treats null as an explicit clear and merges custom fields', () => {
    const changes = diffIssue(current, { storyPoints: null, customFields: { team: 'core' } });
    expect(changes).toEqual([
      { column: 'story_points', label: 'story_points', oldValue: 3, newValue: null },
      {
        column: 'custom_fields',
        label: 'custom_fields',
        oldValue: { severity: 'low' },
        newValue: { severity: 'low', team: 'core' },
      },
    ]);
  });
});

describe('updateIssue', () => {
  it('rejects a stale If-Match version without writing anything', async () => {
    mocks.clientQuery.mockResolvedValueOnce({ rows: [current] });

    const result = await updateIssue(7, { summary: 'New' }, alice, 3);

    expect(result).toEqual({ ok: false, reason: 'version_conflict', currentVersion: 4 });
    expect(mocks.clientQuery).toHaveBeenCalledTimes(1);
    expect(mocks.clientQuery.mock.calls[0][0]).toContain('FOR UPDATE');
    expect(mocks.afterIssueCommitted).not.toHaveBeenCalled();
  });

  it('bumps the version and writes history in the same transaction', async () => {
    const statements: string[] = [];
    mocks.clientQuery.mockImplementation(async (sql: string, params: unknown[]) => {
      statements.push(sql);
      if (sql.includes('FOR UPDATE')) return { rows: [current] };
      if (sql.startsWith('UPDATE issues')) return { rows: [{ ...current, summary: params[0], version: 5 }] };
      if (sql.includes('FROM projects')) return { rows: [{ key: 'DEMO' }] };
      return { rows: [] };
    });

    const result = await updateIssue(7, { summary: 'New summary' }, alice, 4);

    expect(result).toMatchObject({ ok: true, changed: ['summary'], issue: { version: 5 } });
    expect(statements.find((s) => s.startsWith('UPDATE issues'))).toContain('version = version + 1');
    const historyCall = mocks.clientQuery.mock.calls.find(([sql]) => String(sql).includes('issue_history'));
    expect(historyCall?.[1]).toEqual([7, 'u-alice', 'summary', 'Old summary', 'New summary']);
    expect(mocks.afterIssueCommitted).toHaveBeenCalledWith(
      expect.objectContaining({ event_type: 'updated', changes: { summary: { old: 'Old summary', new: 'New summary' } } })
    );
  });

  it('writes nothing and keeps the version when nothing changed', async () => {
    mocks.clientQuery.mockResolvedValueOnce({ rows: [current] });
    const result = await updateIssue(7, { summary: 'Old summary' }, alice, 4);
    expect(result).toMatchObject({ ok: true, changed: [], issue: { version: 4 } });
    expect(mocks.clientQuery).toHaveBeenCalledTimes(1);
  });
});
