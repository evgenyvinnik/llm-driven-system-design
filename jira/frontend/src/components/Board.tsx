import { useState } from 'react';
import { clsx } from 'clsx';
import type { IssueWithDetails } from '../types';
import { IssueTypeIcon, PriorityIcon, Avatar, Spinner, EmptyState } from './ui';
import * as api from '../services/api';
import { ApiError } from '../services/api';
import { useIssueStore } from '../stores';

export { KanbanBoard } from './board/KanbanBoard';

// Backlog component
interface BacklogProps {
  backlogIssues: IssueWithDetails[];
  sprintIssues: IssueWithDetails[];
  sprintName?: string;
  sprintId?: number;
  onIssueClick: (issue: IssueWithDetails) => void;
  isLoading?: boolean;
}

/** Renders the backlog view with sprint and backlog issue sections and drag-to-sprint support. */
export function Backlog({
  backlogIssues,
  sprintIssues,
  sprintName,
  sprintId,
  onIssueClick,
  isLoading,
}: BacklogProps) {
  const { updateIssueInList } = useIssueStore();
  const [error, setError] = useState<string | null>(null);

  /** Moves an issue in or out of the sprint, guarded by the version the user saw. */
  const moveIssue = async (issue: IssueWithDetails, target: number | null) => {
    setError(null);
    try {
      const updated = await api.updateIssue(issue.id, { sprintId: target }, issue.version);
      updateIssueInList(updated);
    } catch (err) {
      if (err instanceof ApiError && err.status === 412 && err.body.issue) {
        // Someone changed the issue first: show what it looks like now; the user can retry.
        updateIssueInList(err.body.issue as IssueWithDetails);
      }
      setError(err instanceof Error ? err.message : 'Failed to move the issue');
    }
  };

  const handleMoveToSprint = (issue: IssueWithDetails) => (sprintId ? moveIssue(issue, sprintId) : undefined);
  const handleMoveToBacklog = (issue: IssueWithDetails) => moveIssue(issue, null);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-96">
        <Spinner size="lg" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {error && (
        <div role="alert" className="p-3 bg-red-50 text-red-700 rounded text-sm">
          {error}
        </div>
      )}

      {/* Active Sprint */}
      {sprintId && (
        <div className="bg-white rounded-lg shadow-sm">
          <div className="p-4 border-b flex items-center justify-between">
            <div>
              <h2 className="font-semibold text-lg">{sprintName || 'Sprint'}</h2>
              <p className="text-sm text-gray-500">
                {sprintIssues.length} {sprintIssues.length === 1 ? 'issue' : 'issues'}
              </p>
            </div>
          </div>
          <div className="divide-y">
            {sprintIssues.length === 0 ? (
              <EmptyState message="No issues in this sprint" />
            ) : (
              sprintIssues.map((issue) => (
                <BacklogItem
                  key={issue.id}
                  issue={issue}
                  onClick={() => onIssueClick(issue)}
                  onMoveToBacklog={() => handleMoveToBacklog(issue)}
                />
              ))
            )}
          </div>
        </div>
      )}

      {/* Backlog */}
      <div className="bg-white rounded-lg shadow-sm">
        <div className="p-4 border-b flex items-center justify-between">
          <div>
            <h2 className="font-semibold text-lg">Backlog</h2>
            <p className="text-sm text-gray-500">
              {backlogIssues.length} {backlogIssues.length === 1 ? 'issue' : 'issues'}
            </p>
          </div>
        </div>
        <div className="divide-y">
          {backlogIssues.length === 0 ? (
            <EmptyState message="No issues in backlog" />
          ) : (
            backlogIssues.map((issue) => (
              <BacklogItem
                key={issue.id}
                issue={issue}
                onClick={() => onIssueClick(issue)}
                onMoveToSprint={sprintId ? () => handleMoveToSprint(issue) : undefined}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
}

interface BacklogItemProps {
  issue: IssueWithDetails;
  onClick: () => void;
  onMoveToSprint?: () => void;
  onMoveToBacklog?: () => void;
}

function BacklogItem({ issue, onClick, onMoveToSprint, onMoveToBacklog }: BacklogItemProps) {
  return (
    <div className="p-3 flex items-center gap-3 hover:bg-gray-50 cursor-pointer group" onClick={onClick}>
      <IssueTypeIcon type={issue.issue_type} />

      <span className="text-sm font-medium text-gray-600 w-20">{issue.key}</span>

      <span className="flex-1 text-sm truncate">{issue.summary}</span>

      <PriorityIcon priority={issue.priority} />

      {issue.story_points != null && (
        <span className="px-1.5 py-0.5 bg-gray-100 rounded text-xs text-gray-600">
          {issue.story_points}
        </span>
      )}

      {issue.assignee && <Avatar user={issue.assignee} size="sm" />}

      <div
        className={clsx(
          'px-2 py-0.5 rounded text-xs',
          issue.status.category === 'todo' && 'bg-gray-200 text-gray-700',
          issue.status.category === 'in_progress' && 'bg-blue-100 text-blue-700',
          issue.status.category === 'done' && 'bg-green-100 text-green-700'
        )}
      >
        {issue.status.name}
      </div>

      {(onMoveToSprint || onMoveToBacklog) && (
        <div className="opacity-0 group-hover:opacity-100 transition-opacity">
          {onMoveToSprint && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onMoveToSprint();
              }}
              className="p-1 text-blue-600 hover:bg-blue-50 rounded"
              title="Move to sprint"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 10l7-7m0 0l7 7m-7-7v18" />
              </svg>
            </button>
          )}
          {onMoveToBacklog && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onMoveToBacklog();
              }}
              className="p-1 text-gray-600 hover:bg-gray-100 rounded"
              title="Move to backlog"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 14l-7 7m0 0l-7-7m7 7V3" />
              </svg>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
