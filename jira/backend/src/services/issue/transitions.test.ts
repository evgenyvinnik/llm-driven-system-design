import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Issue, User, WorkflowWithStatuses } from '../../types/index.js';

const mocks = vi.hoisted(() => ({
  getIssueRow: vi.fn(),
  getWorkflowByProject: vi.fn(),
  afterIssueCommitted: vi.fn(),
  clientQuery: vi.fn(),
}));

vi.mock('../../config/database.js', () => ({
  query: vi.fn(),
  withTransaction: async (callback: (client: unknown) => Promise<unknown>) =>
    callback({ query: mocks.clientQuery }),
}));
vi.mock('../../config/redis.js', () => ({ redis: {}, cacheGet: vi.fn(), cacheSet: vi.fn(), cacheDel: vi.fn() }));
vi.mock('../../config/logger.js', () => {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { logger: { ...log, child: () => log } };
});
vi.mock('./queries.js', () => ({ getIssueRow: mocks.getIssueRow }));
vi.mock('./afterCommit.js', () => ({ afterIssueCommitted: mocks.afterIssueCommitted }));
vi.mock('../workflowService.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../workflowService.js')>()),
  getWorkflowByProject: mocks.getWorkflowByProject,
}));

import { transitionIssue } from './transitions.js';

const alice = { id: 'u-alice', role: 'user' } as User;

function issue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: 5,
    key: 'DEMO-5',
    project_id: 'p-1',
    status_id: 1,
    assignee_id: 'u-alice',
    version: 3,
    story_points: 3,
    ...overrides,
  } as Issue;
}

function workflow(transition: Partial<WorkflowWithStatuses['transitions'][number]> = {}): WorkflowWithStatuses {
  return {
    id: 1,
    statuses: [
      { id: 1, name: 'To Do' },
      { id: 2, name: 'In Progress' },
    ],
    transitions: [
      {
        id: 10,
        workflow_id: 1,
        name: 'Start Progress',
        from_status_id: 1,
        to_status_id: 2,
        conditions: [],
        validators: [],
        post_functions: [],
        ...transition,
      },
    ],
  } as unknown as WorkflowWithStatuses;
}

/**
 * Simulates PostgreSQL; casResults decides how each compare-and-swap UPDATE turns out.
 * A successful UPDATE returns the stored row (`stored`) with the new status and version.
 */
function database(casResults: boolean[], stored: Issue = issue()) {
  const history: unknown[][] = [];
  mocks.clientQuery.mockImplementation(async (sql: string, params: unknown[]) => {
    if (sql.includes('SET status_id')) {
      const applied = casResults.shift();
      return { rows: applied ? [{ ...stored, status_id: 2, version: (params[2] as number) + 1 }] : [] };
    }
    if (sql.includes('SET assignee_id')) return { rows: [issue({ status_id: 2, assignee_id: params[0] as string })] };
    if (sql.includes('FROM users')) return { rows: [{ label: params[0] === 'u-alice' ? 'Alice' : 'Bob' }] };
    if (sql.includes('INSERT INTO issue_history')) {
      history.push(params);
      return { rows: [] };
    }
    if (sql.includes('FROM projects')) return { rows: [{ key: 'DEMO' }] };
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  return history;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('transitionIssue', () => {
  it('commits the status change with its history row and publishes after commit', async () => {
    mocks.getIssueRow.mockResolvedValue(issue());
    mocks.getWorkflowByProject.mockResolvedValue(workflow());
    const history = database([true]);

    const result = await transitionIssue(5, 10, alice, ['Developer']);

    expect(result).toMatchObject({ ok: true, fromStatus: 'To Do', toStatus: 'In Progress' });
    expect(history).toEqual([[5, 'u-alice', 'status', 'To Do', 'In Progress']]);
    expect(mocks.afterIssueCommitted).toHaveBeenCalledWith(
      expect.objectContaining({ event_type: 'transitioned', changes: { status: { old: 'To Do', new: 'In Progress' } } })
    );
  });

  it('re-evaluates on a fresh read when the compare-and-swap loses a race', async () => {
    mocks.getIssueRow.mockResolvedValueOnce(issue({ version: 3 })).mockResolvedValueOnce(issue({ version: 4 }));
    mocks.getWorkflowByProject.mockResolvedValue(workflow());
    database([false, true]);

    const result = await transitionIssue(5, 10, alice, []);

    expect(result.ok).toBe(true);
    expect(mocks.getIssueRow).toHaveBeenCalledTimes(2);
    const casVersions = mocks.clientQuery.mock.calls
      .filter(([sql]) => String(sql).includes('SET status_id'))
      .map(([, params]) => (params as unknown[])[2]);
    expect(casVersions).toEqual([3, 4]);
  });

  it('gives up with a conflict when the issue keeps changing', async () => {
    mocks.getIssueRow.mockResolvedValue(issue());
    mocks.getWorkflowByProject.mockResolvedValue(workflow());
    database([false, false, false]);

    expect(await transitionIssue(5, 10, alice, [])).toMatchObject({ ok: false, code: 'conflict' });
    expect(mocks.afterIssueCommitted).not.toHaveBeenCalled();
  });

  it('refuses a transition that does not start from the current status', async () => {
    mocks.getIssueRow.mockResolvedValue(issue({ status_id: 2 }));
    mocks.getWorkflowByProject.mockResolvedValue(workflow());

    const result = await transitionIssue(5, 10, alice, []);
    expect(result).toMatchObject({ ok: false, code: 'invalid_from_status' });
    expect(mocks.clientQuery).not.toHaveBeenCalled();
  });

  it('blocks on conditions before validators, and fails closed on unknown conditions', async () => {
    mocks.getIssueRow.mockResolvedValue(issue({ assignee_id: 'u-bob', story_points: undefined }));
    mocks.getWorkflowByProject.mockResolvedValue(
      workflow({
        conditions: [{ type: 'issue_assignee', config: {} }],
        validators: [{ type: 'field_required', config: { field: 'story_points' } }],
      })
    );
    expect(await transitionIssue(5, 10, alice, [])).toMatchObject({
      ok: false,
      code: 'condition_failed',
      message: 'Only the assignee can do this',
    });

    mocks.getWorkflowByProject.mockResolvedValue(
      workflow({ conditions: [{ type: 'user_in_grop', config: {} } as never] })
    );
    expect(await transitionIssue(5, 10, alice, [])).toMatchObject({ ok: false, code: 'condition_failed' });
    expect(mocks.clientQuery).not.toHaveBeenCalled();
  });

  it('reports the failing field when a validator blocks the move', async () => {
    mocks.getIssueRow.mockResolvedValue(issue({ story_points: undefined }));
    mocks.getWorkflowByProject.mockResolvedValue(
      workflow({ validators: [{ type: 'field_required', config: { field: 'story_points' } }] })
    );
    expect(await transitionIssue(5, 10, alice, [])).toMatchObject({
      ok: false,
      code: 'validation_failed',
      field: 'story_points',
    });
  });

  it('applies post-functions in the same transaction, with their own history rows', async () => {
    const stored = issue({ assignee_id: 'u-bob' });
    mocks.getIssueRow.mockResolvedValue(stored);
    mocks.getWorkflowByProject.mockResolvedValue(
      workflow({ post_functions: [{ type: 'assign_to_current_user', config: {} }] })
    );
    const history = database([true], stored);

    const result = await transitionIssue(5, 10, alice, []);

    expect(result.ok && result.issue.assignee_id).toBe('u-alice');
    expect(history).toEqual([[5, 'u-alice', 'status', 'To Do', 'In Progress', 5, 'u-alice', 'assignee', 'Bob', 'Alice']]);
  });
});
