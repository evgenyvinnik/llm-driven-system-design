import { PoolClient } from 'pg';
import { withTransaction } from '../../config/database.js';
import { logger } from '../../config/logger.js';
import { concurrencyConflictsCounter } from '../../config/metrics.js';
import { Issue } from '../../types/index.js';
import { rankBetween } from '../rank.js';

export type RankResult =
  | { ok: true; issue: Issue; moved: boolean }
  | { ok: false; code: 'issue_not_found' | 'invalid_anchor' | 'conflict'; message: string };

/** Where to put the issue: directly after one issue, or directly before one. */
export interface RankPlacement {
  afterId?: number | null;
  beforeId?: number | null;
}

const MAX_ATTEMPTS = 3;

class RankAnchorError extends Error {}

function isRankCollision(error: unknown): boolean {
  const pgError = error as { code?: string; constraint?: string };
  return pgError.code === '23505' && pgError.constraint === 'idx_issues_project_rank';
}

async function anchorRank(client: PoolClient, anchorId: number, issue: Issue): Promise<string> {
  if (anchorId === issue.id) throw new RankAnchorError('An issue cannot be ranked relative to itself');
  const { rows } = await client.query<{ rank: string }>(
    'SELECT rank FROM issues WHERE id = $1 AND project_id = $2',
    [anchorId, issue.project_id]
  );
  if (!rows[0]) throw new RankAnchorError('The neighbouring issue must be in the same project');
  return rows[0].rank;
}

/**
 * Moves an issue in its project's rank order (one order per project, shared by the board
 * columns and the backlog). Only the moved issue's key changes: the new key is computed
 * between the anchor and the anchor's current neighbour, read inside the transaction.
 *
 * "After X" and "before Y" are resolved against the order as it is now, not as the client
 * last saw it, so a stale board still produces a sensible result. Two moves into the same
 * gap compute the same key; the unique (project_id, rank) index rejects the second, which
 * re-reads its neighbours and retries.
 *
 * Ranking does not bump the issue's version: it is board metadata, and an edit to the
 * summary should not fail with 412 because a teammate reordered the board.
 *
 * @param issueId - Issue to move
 * @param placement - afterId (place directly below it) or beforeId (directly above it)
 */
export async function rankIssue(issueId: number, placement: RankPlacement): Promise<RankResult> {
  const log = logger.child({ operation: 'rankIssue', issueId });

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await withTransaction<RankResult>(async (client) => {
        const { rows } = await client.query<Issue>('SELECT * FROM issues WHERE id = $1 FOR UPDATE', [issueId]);
        const issue = rows[0];
        if (!issue) return { ok: false, code: 'issue_not_found', message: 'Issue not found' };

        let lower: string | null;
        let upper: string | null;
        if (placement.afterId != null) {
          lower = await anchorRank(client, placement.afterId, issue);
          const next = await client.query<{ rank: string }>(
            `SELECT rank FROM issues
             WHERE project_id = $1 AND rank > $2 AND id <> $3
             ORDER BY rank LIMIT 1`,
            [issue.project_id, lower, issue.id]
          );
          upper = next.rows[0]?.rank ?? null;
        } else if (placement.beforeId != null) {
          upper = await anchorRank(client, placement.beforeId, issue);
          const previous = await client.query<{ rank: string }>(
            `SELECT rank FROM issues
             WHERE project_id = $1 AND rank < $2 AND id <> $3
             ORDER BY rank DESC LIMIT 1`,
            [issue.project_id, upper, issue.id]
          );
          lower = previous.rows[0]?.rank ?? null;
        } else {
          throw new RankAnchorError('Provide afterId or beforeId');
        }

        // Already in place: the issue sits directly between the two neighbours.
        if ((lower === null || issue.rank > lower) && (upper === null || issue.rank < upper)) {
          return { ok: true, issue, moved: false };
        }

        const { rows: updated } = await client.query<Issue>(
          'UPDATE issues SET rank = $1 WHERE id = $2 RETURNING *',
          [rankBetween(lower, upper), issueId]
        );
        return { ok: true, issue: updated[0], moved: true };
      });
    } catch (error) {
      if (error instanceof RankAnchorError) {
        return { ok: false, code: 'invalid_anchor', message: error.message };
      }
      if (isRankCollision(error)) {
        concurrencyConflictsCounter.inc({ operation: 'rank' });
        log.info({ attempt }, 'Rank key collided with a concurrent move, retrying');
        continue;
      }
      throw error;
    }
  }

  return { ok: false, code: 'conflict', message: 'The board kept changing; reload it and try again' };
}
