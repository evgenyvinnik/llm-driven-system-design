import type { IssueWithDetails, Status } from '../../types';

/**
 * Pure helpers for the board. The issue list arrives from the server in rank order and
 * the board keeps it that way: columns are filtered views of one list, so moving a card
 * never needs a second copy of the data.
 */

/** Byte-wise comparison, matching the server's COLLATE "C" ordering (not localeCompare). */
export function compareRank(a: IssueWithDetails, b: IssueWithDetails): number {
  if (a.rank === b.rank) return 0;
  return a.rank < b.rank ? -1 : 1;
}

/** Issues per status column, preserving list (rank) order. */
export function groupByStatus(issues: IssueWithDetails[], statuses: Status[]): Record<number, IssueWithDetails[]> {
  const grouped: Record<number, IssueWithDetails[]> = {};
  for (const status of statuses) grouped[status.id] = [];
  for (const issue of issues) grouped[issue.status_id]?.push(issue);
  return grouped;
}

/**
 * Neighbours for a card dropped at `index` in a column. The index counts the column's
 * cards without the dragged one. Returns the card that will sit directly above and below.
 */
export function dropNeighbors(
  column: IssueWithDetails[],
  movedId: number,
  index: number
): { above: IssueWithDetails | null; below: IssueWithDetails | null } {
  const others = column.filter((issue) => issue.id !== movedId);
  return { above: others[index - 1] ?? null, below: others[index] ?? null };
}

/**
 * Moves an issue in the list so it sits directly after `above` (or directly before
 * `below` when dropped at the top). Used for the optimistic update; the issue keeps its
 * old rank until the server answers, so sorting by rank undoes the move.
 */
export function placeIssue(
  issues: IssueWithDetails[],
  moved: IssueWithDetails,
  above: IssueWithDetails | null,
  below: IssueWithDetails | null
): IssueWithDetails[] {
  const rest = issues.filter((issue) => issue.id !== moved.id);
  const anchor = above ?? below;
  if (!anchor) return issues;
  const at = rest.findIndex((issue) => issue.id === anchor.id);
  if (at < 0) return issues;
  rest.splice(above ? at + 1 : at, 0, moved);
  return rest;
}

/** Copy of the issue shown in another status column while its transition is in flight. */
export function withStatus(issue: IssueWithDetails, status: Status): IssueWithDetails {
  return { ...issue, status_id: status.id, status };
}
