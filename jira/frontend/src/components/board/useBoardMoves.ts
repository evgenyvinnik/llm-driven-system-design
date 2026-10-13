import { useCallback, useRef, useState } from 'react';
import type { IssueWithDetails, Workflow } from '../../types';
import * as api from '../../services/api';
import { ApiError } from '../../services/api';
import { useIssueStore } from '../../stores';
import { compareRank, dropNeighbors, placeIssue, withStatus } from './boardModel';

export interface BoardMessage {
  tone: 'info' | 'error';
  text: string;
}

/**
 * Board moves, applied optimistically and reconciled with the server.
 *
 * - transition: the card jumps to the target column at once; the server's workflow
 *   engine decides. A refusal (403 condition, 422 validator, 409 stale) restores only that
 *   card and says why, because these are rules working correctly, not network noise.
 * - reorder: the card moves within its column at once; the server picks the new rank
 *   between its neighbours. On failure the list is re-sorted by rank, which undoes the move.
 *
 * Each card's moves are numbered, so a slow response for an older move of the same card
 * cannot overwrite the result of a newer one.
 */
const issuesNow = () => useIssueStore.getState().issues;
const setIssues = (issues: IssueWithDetails[]) => useIssueStore.getState().setIssues(issues);

const explain = (error: unknown) =>
  error instanceof ApiError ? error.message : 'Network error: the change was not saved';

/** Numbers a new move of one card; only the newest move's response is applied. */
function beginMove(moves: Map<number, number>, issueId: number): number {
  const sequence = (moves.get(issueId) ?? 0) + 1;
  moves.set(issueId, sequence);
  return sequence;
}

export function useBoardMoves(workflow: Workflow, onConflict: () => void) {
  const [message, setMessage] = useState<BoardMessage | null>(null);
  const latestMove = useRef(new Map<number, number>());

  const transition = useCallback(
    async (issue: IssueWithDetails, targetStatusId: number) => {
      const target = workflow.statuses.find((s) => s.id === targetStatusId);
      if (!target) return;

      const sequence = beginMove(latestMove.current, issue.id);
      setIssues(issuesNow().map((i) => (i.id === issue.id ? withStatus(i, target) : i)));
      setMessage({ tone: 'info', text: `Moving ${issue.key} to ${target.name}…` });

      try {
        const available = await api.getIssueTransitions(issue.id);
        const match = available.find((t) => t.to_status_id === targetStatusId);
        if (!match) {
          throw new ApiError(`${issue.key} can't move from ${issue.status.name} to ${target.name}`, 409, 'no_transition');
        }
        const updated = await api.executeTransition(issue.id, match.id);
        if (latestMove.current.get(issue.id) !== sequence) return;
        setIssues(issuesNow().map((i) => (i.id === updated.id ? updated : i)));
        setMessage({ tone: 'info', text: `${issue.key} moved to ${updated.status.name}` });
      } catch (error) {
        if (latestMove.current.get(issue.id) !== sequence) return;
        // Restore this card only; other cards may have moves of their own in flight.
        setIssues(issuesNow().map((i) => (i.id === issue.id ? issue : i)));
        setMessage({ tone: 'error', text: explain(error) });
        if (error instanceof ApiError && error.status === 409 && error.code !== 'no_transition') {
          onConflict();
        }
      }
    },
    [workflow.statuses, onConflict]
  );

  const reorder = useCallback(async (issue: IssueWithDetails, column: IssueWithDetails[], index: number) => {
    const originalIndex = column.findIndex((i) => i.id === issue.id);
    if (originalIndex === index) return;
    const { above, below } = dropNeighbors(column, issue.id, index);
    if (!above && !below) return;

    const sequence = beginMove(latestMove.current, issue.id);
    setIssues(placeIssue(issuesNow(), issue, above, below));

    try {
      const placed = await api.rankIssue(issue.id, above ? { afterId: above.id } : { beforeId: below!.id });
      if (latestMove.current.get(issue.id) !== sequence) return;
      setIssues(issuesNow().map((i) => (i.id === placed.id ? { ...i, rank: placed.rank } : i)).sort(compareRank));
      setMessage({
        tone: 'info',
        text: above ? `${issue.key} moved below ${above.key}` : `${issue.key} moved to the top`,
      });
    } catch (error) {
      if (latestMove.current.get(issue.id) !== sequence) return;
      setIssues([...issuesNow()].sort(compareRank));
      setMessage({ tone: 'error', text: explain(error) });
    }
  }, []);

  return { message, transition, reorder };
}
