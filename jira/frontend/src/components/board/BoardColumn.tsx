import { Fragment, useRef } from 'react';
import { clsx } from 'clsx';
import type { IssueWithDetails, Status } from '../../types';
import { BoardCard } from './BoardCard';

interface BoardColumnProps {
  status: Status;
  issues: IssueWithDetails[];
  draggedId: number | null;
  /** Where a same-column drop would land (index among the other cards), or null. */
  dropIndex: number | null;
  isDragOver: boolean;
  canDrag: boolean;
  onIssueClick: (issue: IssueWithDetails) => void;
  onDragStart: (issue: IssueWithDetails) => void;
  onDragEnd: () => void;
  onDragOverIndex: (index: number) => void;
  onDrop: (index: number) => void;
  onKeyboardMove?: (issue: IssueWithDetails, offset: -1 | 1) => void;
}

const CATEGORY_COLORS: Record<string, string> = {
  todo: 'bg-gray-400',
  in_progress: 'bg-blue-500',
  done: 'bg-green-500',
};

/** One workflow status. Accepts drops from other columns (transition) and its own (reorder). */
export function BoardColumn({
  status,
  issues,
  draggedId,
  dropIndex,
  isDragOver,
  canDrag,
  onIssueClick,
  onDragStart,
  onDragEnd,
  onDragOverIndex,
  onDrop,
  onKeyboardMove,
}: BoardColumnProps) {
  const listRef = useRef<HTMLDivElement>(null);

  /** Index among the cards other than the dragged one, from the pointer's height. */
  const indexAt = (clientY: number) => {
    const cards = Array.from(listRef.current?.querySelectorAll<HTMLElement>('[data-issue-id]') ?? []).filter(
      (el) => Number(el.dataset.issueId) !== draggedId
    );
    const at = cards.findIndex((el) => {
      const box = el.getBoundingClientRect();
      return clientY < box.top + box.height / 2;
    });
    return at === -1 ? cards.length : at;
  };

  const showsIndicator = dropIndex !== null && issues.some((issue) => issue.id === draggedId);
  const indicator = <div className="h-0.5 bg-blue-500 rounded" aria-hidden="true" />;
  let position = 0;

  return (
    <div
      className={clsx(
        // Grow to share the available width so a typical 4-status workflow fills
        // the board, but never shrink below a readable card width — past that the
        // parent's overflow-x takes over, as it must for longer workflows.
        'flex-1 min-w-[17rem] bg-gray-100 rounded-lg',
        isDragOver && !showsIndicator && 'ring-2 ring-blue-400'
      )}
      onDragOver={(e) => {
        e.preventDefault();
        onDragOverIndex(indexAt(e.clientY));
      }}
      onDrop={(e) => {
        e.preventDefault();
        onDrop(indexAt(e.clientY));
      }}
    >
      <div className="p-3 flex items-center gap-2">
        <div className={clsx('w-3 h-3 rounded', CATEGORY_COLORS[status.category])} />
        <h3 className="font-medium text-gray-700">{status.name}</h3>
        <span className="ml-auto text-sm text-gray-500">{issues.length}</span>
      </div>

      <div ref={listRef} className="p-2 space-y-2 min-h-[200px] max-h-[calc(100vh-250px)] overflow-y-auto">
        {issues.length === 0 ? (
          <div className="text-center text-gray-400 py-8 text-sm">No issues</div>
        ) : (
          issues.map((issue) => {
            const before = issue.id !== draggedId && showsIndicator && dropIndex === position;
            if (issue.id !== draggedId) position++;
            return (
              <Fragment key={issue.id}>
                {before && indicator}
                <BoardCard
                  issue={issue}
                  draggable={canDrag}
                  isDragging={issue.id === draggedId}
                  onClick={() => onIssueClick(issue)}
                  onDragStart={() => onDragStart(issue)}
                  onDragEnd={onDragEnd}
                  onKeyboardMove={onKeyboardMove ? (offset) => onKeyboardMove(issue, offset) : undefined}
                />
              </Fragment>
            );
          })
        )}
        {showsIndicator && dropIndex === position && indicator}
      </div>
    </div>
  );
}
