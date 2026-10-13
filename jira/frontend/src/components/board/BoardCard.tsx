import { clsx } from 'clsx';
import type { IssueWithDetails } from '../../types';
import { IssueTypeIcon, PriorityIcon, Avatar } from '../ui';

interface BoardCardProps {
  issue: IssueWithDetails;
  draggable: boolean;
  isDragging: boolean;
  onClick: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  /** Alt+ArrowUp / Alt+ArrowDown: keyboard equivalent of dragging within the column. */
  onKeyboardMove?: (offset: -1 | 1) => void;
}

/** One issue on the board: opens on click or Enter, drags between and within columns. */
export function BoardCard({ issue, draggable, isDragging, onClick, onDragStart, onDragEnd, onKeyboardMove }: BoardCardProps) {
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onClick();
    } else if (e.altKey && onKeyboardMove && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      onKeyboardMove(e.key === 'ArrowUp' ? -1 : 1);
    }
  };

  return (
    <div
      draggable={draggable}
      data-testid="issue-card"
      data-issue-id={issue.id}
      role="button"
      tabIndex={0}
      aria-label={`${issue.key}: ${issue.summary}`}
      aria-keyshortcuts={onKeyboardMove ? 'Alt+ArrowUp Alt+ArrowDown' : undefined}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move';
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      onClick={onClick}
      onKeyDown={handleKeyDown}
      className={clsx(
        'bg-white rounded shadow-sm p-3 cursor-pointer hover:shadow-md transition-shadow border border-gray-200',
        'focus:outline-none focus:ring-2 focus:ring-blue-500',
        isDragging && 'opacity-50'
      )}
    >
      <div className="text-sm text-gray-900 mb-2 line-clamp-2">{issue.summary}</div>

      <div className="flex items-center gap-2 text-xs text-gray-500">
        <IssueTypeIcon type={issue.issue_type} className="w-4 h-4" />
        <span className="font-medium">{issue.key}</span>
      </div>

      <div className="flex items-center justify-between mt-2">
        <div className="flex items-center gap-1">
          <PriorityIcon priority={issue.priority} />
          {issue.story_points != null && (
            <span className="ml-1 px-1.5 py-0.5 bg-gray-100 rounded text-xs text-gray-600">
              {issue.story_points}
            </span>
          )}
        </div>
        {issue.assignee && <Avatar user={issue.assignee} size="sm" />}
      </div>

      {issue.epic && (
        <div className="mt-2 text-xs px-2 py-0.5 bg-purple-100 text-purple-700 rounded inline-block">
          {issue.epic.key}
        </div>
      )}
    </div>
  );
}
