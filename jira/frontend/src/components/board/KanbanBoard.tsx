import { useMemo, useState } from 'react';
import { clsx } from 'clsx';
import type { IssueWithDetails, Workflow } from '../../types';
import { Spinner } from '../ui';
import { useProjectStore } from '../../stores';
import { BoardColumn } from './BoardColumn';
import { groupByStatus } from './boardModel';
import { useBoardMoves } from './useBoardMoves';

interface BoardProps {
  issues: IssueWithDetails[];
  workflow: Workflow;
  onIssueClick: (issue: IssueWithDetails) => void;
  isLoading?: boolean;
  /** Called when the server reports the board is stale (409), so the page can refetch. */
  onConflict?: () => void;
}

const noop = () => {};

/**
 * Kanban board: one column per workflow status. Dropping a card on another column runs
 * a workflow transition; dropping it within its column (or Alt+Arrow on a focused card)
 * changes its rank. Both apply immediately and are reconciled with the server; results
 * are announced in a live region so keyboard and screen-reader users hear them too.
 */
export function KanbanBoard({ issues, workflow, onIssueClick, isLoading, onConflict }: BoardProps) {
  const permissions = useProjectStore((state) => state.permissions);
  const canTransition = permissions.includes('transition_issue');
  const canRank = permissions.includes('edit_issue');

  const [dragged, setDragged] = useState<IssueWithDetails | null>(null);
  const [dropTarget, setDropTarget] = useState<{ statusId: number; index: number } | null>(null);
  const { message, transition, reorder } = useBoardMoves(workflow, onConflict ?? noop);

  const columns = useMemo(() => groupByStatus(issues, workflow.statuses), [issues, workflow.statuses]);

  const endDrag = () => {
    setDragged(null);
    setDropTarget(null);
  };

  const handleDrop = (statusId: number, index: number) => {
    const issue = dragged;
    endDrag();
    if (!issue) return;
    if (issue.status_id === statusId) {
      if (canRank) reorder(issue, columns[statusId] ?? [], index);
    } else if (canTransition) {
      transition(issue, statusId);
    }
  };

  // Moving one place up or down: the target index among the other cards is simply the
  // card's own index plus the offset.
  const handleKeyboardMove = (issue: IssueWithDetails, offset: -1 | 1) => {
    const column = columns[issue.status_id] ?? [];
    const index = column.findIndex((i) => i.id === issue.id) + offset;
    if (index < 0 || index >= column.length) return;
    reorder(issue, column, index);
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-96">
        <Spinner size="lg" />
      </div>
    );
  }

  return (
    <div>
      <div
        role="status"
        aria-live="polite"
        className={clsx(
          'mb-3 text-sm min-h-[1.25rem]',
          message?.tone === 'error' ? 'text-red-700' : 'text-gray-500'
        )}
      >
        {message?.text}
      </div>

      <div className="flex gap-4 overflow-x-auto pb-4">
        {workflow.statuses.map((status) => (
          <BoardColumn
            key={status.id}
            status={status}
            issues={columns[status.id] || []}
            draggedId={dragged?.id ?? null}
            dropIndex={dropTarget?.statusId === status.id ? dropTarget.index : null}
            isDragOver={dropTarget?.statusId === status.id}
            canDrag={canTransition || canRank}
            onIssueClick={onIssueClick}
            onDragStart={setDragged}
            onDragEnd={endDrag}
            onDragOverIndex={(index) =>
              setDropTarget((current) =>
                current?.statusId === status.id && current.index === index ? current : { statusId: status.id, index }
              )
            }
            onDrop={(index) => handleDrop(status.id, index)}
            onKeyboardMove={canRank ? handleKeyboardMove : undefined}
          />
        ))}
      </div>
    </div>
  );
}
