import { useState, useMemo } from 'react';
import { clsx } from 'clsx';
import type { IssueWithDetails, Status, Workflow } from '../types';
import { IssueTypeIcon, PriorityIcon, Avatar, Spinner, EmptyState } from './ui';
import * as api from '../services/api';
import { useIssueStore, useUIStore } from '../stores';

interface BoardProps {
  issues: IssueWithDetails[];
  workflow: Workflow;
  onIssueClick: (issue: IssueWithDetails) => void;
  isLoading?: boolean;
}

export function KanbanBoard({ issues, workflow, onIssueClick, isLoading }: BoardProps) {
  const { updateIssueInList } = useIssueStore();
  const [draggedIssue, setDraggedIssue] = useState<IssueWithDetails | null>(null);
  const [dragOverColumn, setDragOverColumn] = useState<number | null>(null);

  // Group issues by status
  const issuesByStatus = useMemo(() => {
    const grouped: Record<number, IssueWithDetails[]> = {};
    workflow.statuses.forEach((status) => {
      grouped[status.id] = [];
    });
    issues.forEach((issue) => {
      if (grouped[issue.status_id]) {
        grouped[issue.status_id].push(issue);
      }
    });
    return grouped;
  }, [issues, workflow.statuses]);

  const handleDragStart = (e: React.DragEvent, issue: IssueWithDetails) => {
    setDraggedIssue(issue);
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleDragEnd = () => {
    setDraggedIssue(null);
    setDragOverColumn(null);
  };

  const handleDragOver = (e: React.DragEvent, statusId: number) => {
    e.preventDefault();
    setDragOverColumn(statusId);
  };

  const handleDrop = async (e: React.DragEvent, targetStatusId: number) => {
    e.preventDefault();
    setDragOverColumn(null);

    if (!draggedIssue || draggedIssue.status_id === targetStatusId) {
      setDraggedIssue(null);
      return;
    }

    try {
      // Find the transition to the target status
      const transitions = await api.getIssueTransitions(draggedIssue.id);
      const transition = transitions.find((t) => t.to_status_id === targetStatusId);

      if (transition) {
        const updatedIssue = await api.executeTransition(draggedIssue.id, transition.id);
        updateIssueInList(updatedIssue);
      }
    } catch (error) {
      console.error('Failed to move issue:', error);
    }

    setDraggedIssue(null);
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-96">
        <Spinner size="lg" />
      </div>
    );
  }

  return (
    <div className="flex gap-4 overflow-x-auto pb-4">
      {workflow.statuses.map((status) => (
        <BoardColumn
          key={status.id}
          status={status}
          issues={issuesByStatus[status.id] || []}
          onIssueClick={onIssueClick}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          onDragOver={(e) => handleDragOver(e, status.id)}
          onDrop={(e) => handleDrop(e, status.id)}
          isDragOver={dragOverColumn === status.id}
        />
      ))}
    </div>
  );
}

interface BoardColumnProps {
  status: Status;
  issues: IssueWithDetails[];
  onIssueClick: (issue: IssueWithDetails) => void;
  onDragStart: (e: React.DragEvent, issue: IssueWithDetails) => void;
  onDragEnd: () => void;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
  isDragOver: boolean;
}

function BoardColumn({
  status,
  issues,
  onIssueClick,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
  isDragOver,
}: BoardColumnProps) {
  const categoryColors: Record<string, string> = {
    todo: 'bg-gray-400',
    in_progress: 'bg-blue-500',
    done: 'bg-green-500',
  };

  return (
    <div
      className={clsx(
        'flex-shrink-0 w-72 bg-gray-100 rounded-lg',
        isDragOver && 'ring-2 ring-blue-400'
      )}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <div className="p-3 flex items-center gap-2">
        <div className={clsx('w-3 h-3 rounded', categoryColors[status.category])} />
        <h3 className="font-medium text-gray-700">{status.name}</h3>
        <span className="ml-auto text-sm text-gray-500">{issues.length}</span>
      </div>

      <div className="p-2 space-y-2 min-h-[200px] max-h-[calc(100vh-250px)] overflow-y-auto">
        {issues.length === 0 ? (
          <div className="text-center text-gray-400 py-8 text-sm">No issues</div>
        ) : (
          issues.map((issue) => (
            <BoardCard
              key={issue.id}
              issue={issue}
              onClick={() => onIssueClick(issue)}
              onDragStart={(e) => onDragStart(e, issue)}
              onDragEnd={onDragEnd}
            />
          ))
        )}
      </div>
    </div>
  );
}

interface BoardCardProps {
  issue: IssueWithDetails;
  onClick: () => void;
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: () => void;
}

function BoardCard({ issue, onClick, onDragStart, onDragEnd }: BoardCardProps) {
  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={onClick}
      className="bg-white rounded shadow-sm p-3 cursor-pointer hover:shadow-md transition-shadow border border-gray-200"
    >
      <div className="text-sm text-gray-900 mb-2 line-clamp-2">{issue.summary}</div>

      <div className="flex items-center gap-2 text-xs text-gray-500">
        <IssueTypeIcon type={issue.issue_type} className="w-4 h-4" />
        <span className="font-medium">{issue.key}</span>
      </div>

      <div className="flex items-center justify-between mt-2">
        <div className="flex items-center gap-1">
          <PriorityIcon priority={issue.priority} />
          {issue.story_points && (
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

// Backlog component
interface BacklogProps {
  backlogIssues: IssueWithDetails[];
  sprintIssues: IssueWithDetails[];
  sprintName?: string;
  sprintId?: number;
  onIssueClick: (issue: IssueWithDetails) => void;
  isLoading?: boolean;
}

export function Backlog({
  backlogIssues,
  sprintIssues,
  sprintName,
  sprintId,
  onIssueClick,
  isLoading,
}: BacklogProps) {
  const { updateIssueInList } = useIssueStore();

  const handleMoveToSprint = async (issue: IssueWithDetails) => {
    if (!sprintId) return;
    try {
      const updated = await api.updateIssue(issue.id, { sprintId });
      updateIssueInList(updated);
    } catch (error) {
      console.error('Failed to move to sprint:', error);
    }
  };

  const handleMoveToBacklog = async (issue: IssueWithDetails) => {
    try {
      const updated = await api.updateIssue(issue.id, { sprintId: null });
      updateIssueInList(updated);
    } catch (error) {
      console.error('Failed to move to backlog:', error);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-96">
        <Spinner size="lg" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Active Sprint */}
      {sprintId && (
        <div className="bg-white rounded-lg shadow-sm">
          <div className="p-4 border-b flex items-center justify-between">
            <div>
              <h2 className="font-semibold text-lg">{sprintName || 'Sprint'}</h2>
              <p className="text-sm text-gray-500">{sprintIssues.length} issues</p>
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
            <p className="text-sm text-gray-500">{backlogIssues.length} issues</p>
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

      {issue.story_points && (
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
